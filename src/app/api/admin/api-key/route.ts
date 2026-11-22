import { z } from "zod";
import { HttpError, requireAdmin } from "@/lib/auth";
import { handle, json } from "@/lib/api";
import { encryptSecret } from "@/lib/crypto";
import { MODELS, getSettings, updateSettings } from "@/lib/settings";

/** Returns ONLY the masked key (last 4 chars). The ciphertext and plaintext never leave the server. */
export const GET = handle(async () => {
  await requireAdmin();
  const s = await getSettings();
  return json({
    configured: !!s.apiKeyCiphertext,
    masked: s.apiKeyLast4 ? `••••••••••••${s.apiKeyLast4}` : null,
    model: s.model,
    models: MODELS.map(({ id, label }) => ({ id, label })),
    conversionsEnabled: s.conversionsEnabled,
  });
});

const Body = z.object({
  apiKey: z.string().trim().min(20).max(300).optional(),
  model: z.string().optional(),
  conversionsEnabled: z.boolean().optional(),
});

export const PUT = handle(async (req: Request) => {
  await requireAdmin();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(400, "Invalid input");
  const { apiKey, model, conversionsEnabled } = parsed.data;
  const patch: Parameters<typeof updateSettings>[0] = {};
  if (apiKey) {
    if (!apiKey.startsWith("sk-ant-")) throw new HttpError(400, "That does not look like an Anthropic API key");
    patch.apiKeyCiphertext = encryptSecret(apiKey);
    patch.apiKeyLast4 = apiKey.slice(-4);
  }
  if (model) {
    if (!MODELS.some((m) => m.id === model)) throw new HttpError(400, "Unknown model");
    patch.model = model;
  }
  if (conversionsEnabled !== undefined) patch.conversionsEnabled = conversionsEnabled;
  await updateSettings(patch);
  return json({ ok: true });
});
