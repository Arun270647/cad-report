import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { db, schema } from "./db";
import { decryptSecret, redactSecrets } from "./crypto";
import { getSettings, modelInfo } from "./settings";
import { HttpError } from "./auth";

export type ErrorType = "auth" | "rate_limit" | "timeout" | "overloaded" | "refusal" | "invalid_output" | "other";

export class ClaudeCallError extends Error {
  constructor(public errorType: ErrorType, message: string, public statusCode?: number) {
    super(message);
  }
}

/** Decrypts the stored key server-side only. The plaintext never leaves this module. */
async function getClient(): Promise<{ client: Anthropic; model: string }> {
  const s = await getSettings();
  if (!s.apiKeyCiphertext) throw new HttpError(503, "The Claude API is not configured. Ask an administrator.");
  const apiKey = decryptSecret(s.apiKeyCiphertext);
  // maxRetries: 0 — we retry ourselves so that every attempt is logged for the health view.
  return { client: new Anthropic({ apiKey, maxRetries: 0, timeout: 200_000 }), model: s.model };
}

export function classifyError(err: unknown): { type: ErrorType; status?: number; retryable: boolean; message: string; retryAfterMs?: number } {
  const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
  if (err instanceof ClaudeCallError) return { type: err.errorType, status: err.statusCode, retryable: err.errorType === "invalid_output", message };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { type: "timeout", retryable: true, message };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return { type: "auth", status: err.status, retryable: false, message };
  if (err instanceof Anthropic.RateLimitError) {
    const ra = Number(err.headers?.get?.("retry-after") ?? 0);
    return { type: "rate_limit", status: 429, retryable: true, message, retryAfterMs: ra > 0 ? ra * 1000 : undefined };
  }
  if (err instanceof Anthropic.APIConnectionError) return { type: "timeout", retryable: true, message };
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const body = (err.error ?? {}) as { error?: { type?: string } };
    if (status === 529 || body?.error?.type === "overloaded_error") return { type: "overloaded", status, retryable: true, message };
    if (status && status >= 500) return { type: "other", status, retryable: true, message };
    return { type: "other", status, retryable: false, message };
  }
  return { type: "other", retryable: false, message };
}

export function estimateCostUsd(model: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) {
  const m = modelInfo(model);
  const inTok = usage.input_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  return (inTok * m.inPerM + cw * m.inPerM * 1.25 + cr * m.inPerM * 0.1 + out * m.outPerM) / 1_000_000;
}

interface CallMeta {
  kind: "extract" | "test" | "health";
  userId?: string | null;
  jobId?: string | null;
}

async function logCall(meta: CallMeta, row: Partial<typeof schema.apiCalls.$inferInsert> & { model: string; success: boolean }) {
  try {
    await db.insert(schema.apiCalls).values({
      kind: meta.kind,
      userId: meta.userId ?? null,
      jobId: meta.jobId ?? null,
      ...row,
      message: row.message ? redactSecrets(row.message).slice(0, 1000) : null,
    });
  } catch (e) {
    console.error("[claude] failed to log call:", redactSecrets(String(e)));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Claude request with retry + exponential backoff on rate-limit / overload / timeout,
 * logging every attempt (latency, tokens, cost, error type) to api_calls.
 */
export async function callClaude<T>(
  meta: CallMeta,
  run: (client: Anthropic, model: string) => Promise<{ value: T; usage: Anthropic.Beta.BetaUsage | Anthropic.Usage; model?: string }>,
  opts: { maxAttempts?: number; deadlineMs?: number } = {},
): Promise<{ value: T; latencyMs: number; costUsd: number; model: string; inputTokens: number; outputTokens: number }> {
  const { client, model } = await getClient();
  const maxAttempts = opts.maxAttempts ?? 4;
  const deadline = Date.now() + (opts.deadlineMs ?? 270_000);
  let lastErr: ReturnType<typeof classifyError> | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now();
    try {
      const { value, usage, model: served } = await run(client, model);
      const latencyMs = Date.now() - t0;
      const costUsd = estimateCostUsd(served ?? model, usage);
      const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      const outputTokens = usage.output_tokens ?? 0;
      await logCall(meta, { model: served ?? model, success: true, statusCode: 200, latencyMs, inputTokens, outputTokens, costUsd, attempt });
      return { value, latencyMs, costUsd, model: served ?? model, inputTokens, outputTokens };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const c = classifyError(err);
      lastErr = c;
      const usage = err instanceof ClaudeCallError ? (err as ClaudeCallError & { usage?: Anthropic.Beta.BetaUsage }).usage : undefined;
      await logCall(meta, {
        model,
        success: false,
        statusCode: c.status ?? null,
        errorType: c.type,
        message: c.message,
        latencyMs,
        attempt,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        costUsd: usage ? estimateCostUsd(model, usage) : 0,
      });
      if (!c.retryable || attempt === maxAttempts) break;
      const backoff = c.retryAfterMs ?? Math.min(30_000, 2000 * 2 ** (attempt - 1)) + Math.random() * 500;
      if (Date.now() + backoff + 30_000 > deadline) break;
      await sleep(backoff);
    }
  }
  throw new ClaudeCallError(lastErr?.type ?? "other", lastErr?.message ?? "Claude request failed", lastErr?.status);
}

/** Minimal request used by "Test connection" and the scheduled health check. */
export async function pingClaude(meta: CallMeta) {
  return callClaude(
    meta,
    async (client, model) => {
      const res = await client.messages.create({
        model,
        max_tokens: 64,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      });
      return { value: res.model, usage: res.usage, model: res.model };
    },
    { maxAttempts: 1, deadlineMs: 60_000 },
  );
}

/** Messages shown to non-admin users: never include provider details or key hints. */
export function userFacingError(type: ErrorType): string {
  switch (type) {
    case "rate_limit":
      return "The extraction service is busy (rate limited). Please retry in a minute.";
    case "overloaded":
      return "The extraction service is temporarily overloaded. Please retry shortly.";
    case "timeout":
      return "The extraction service timed out. Please retry.";
    case "auth":
      return "The extraction service is not available. An administrator has been notified.";
    case "refusal":
      return "This sheet could not be processed by the extraction service.";
    case "invalid_output":
      return "The extraction returned an invalid result for this sheet.";
    default:
      return "The extraction service returned an error. Please retry.";
  }
}
