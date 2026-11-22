import crypto from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (the Claude API key).
 * Format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>
 * The key comes from ENCRYPTION_KEY (32 bytes, base64 or 64-char hex).
 */
function getKey(raw = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export function encryptSecret(plain: string, rawKey?: string): string {
  const key = getKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(payload: string, rawKey?: string): string {
  const [v, ivB64, tagB64, ctB64] = payload.split(":");
  if (v !== "v1" || !ivB64 || !tagB64 || !ctB64) throw new Error("Invalid ciphertext format");
  const key = getKey(rawKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Remove anything that looks like an Anthropic key from free text before storing/logging it. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***").replace(/x-api-key[^,}\n]*/gi, "x-api-key: ***");
}
