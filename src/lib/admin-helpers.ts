import crypto from "node:crypto";
import { z } from "zod";

export function tempPassword() {
  return crypto.randomBytes(9).toString("base64url");
}

export const RuleBody = z.object({
  deviceType: z.string().trim().min(1).max(50),
  rating: z.string().trim().max(50),
  qualifier: z.string().trim().max(50).nullable().optional(),
  mpn: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).nullable().optional(),
});
