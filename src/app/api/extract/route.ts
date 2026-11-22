import { NextResponse } from "next/server";
import { z } from "zod";
import { ExtractError, extractSheet } from "@/lib/server/extract";

export const maxDuration = 300;

const Body = z.object({
  page: z.number().int().min(1).max(500),
  mediaType: z.enum(["image/png", "image/jpeg"]),
  data: z.string().min(100).max(6_000_000),
});

const FRIENDLY: Record<string, string> = {
  not_configured: "The Claude API key has not been set up yet (ANTHROPIC_API_KEY in Vercel).",
  auth: "The Claude API key was rejected. Check ANTHROPIC_API_KEY in Vercel.",
  rate_limit: "Claude API rate limit reached — please retry in a minute.",
  overloaded: "Claude is temporarily overloaded — please retry shortly.",
  timeout: "The Claude API timed out — please retry.",
  refusal: "Claude could not process this sheet.",
  invalid_output: "Claude returned an invalid result for this sheet.",
  other: "The Claude API returned an error.",
};

/** The ONLY server endpoint: one sheet image in, structured component JSON out. The API key never leaves the server. */
export async function POST(req: Request) {
  const passcode = process.env.APP_PASSCODE;
  if (passcode && req.headers.get("x-app-passcode") !== passcode) {
    return NextResponse.json({ error: "Passcode required", code: "passcode" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid page image" }, { status: 400 });
  const { page, mediaType, data } = parsed.data;
  try {
    const out = await extractSheet({ data, mediaType }, page);
    return NextResponse.json(out);
  } catch (e) {
    const err = e instanceof ExtractError ? e : new ExtractError("other", "error");
    const status = err.errorType === "rate_limit" || err.errorType === "overloaded" || err.errorType === "timeout" ? 503 : err.errorType === "not_configured" ? 500 : 502;
    return NextResponse.json({ error: FRIENDLY[err.errorType] ?? FRIENDLY.other, code: err.errorType, retryable: err.retryable }, { status });
  }
}
