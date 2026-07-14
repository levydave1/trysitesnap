import { createHmac, timingSafeEqual } from "node:crypto";

export async function readRawBody(request, maxBytes = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function verifyStripeEvent(rawBody, signatureHeader, secret, toleranceSeconds = 300, now = Date.now()) {
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  const parts = String(signatureHeader || "").split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length) {
    const error = new Error("Invalid Stripe signature header");
    error.status = 400;
    throw error;
  }
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > toleranceSeconds) {
    const error = new Error("Expired Stripe signature");
    error.status = 400;
    throw error;
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest();
  const valid = signatures.some((signature) => {
    try {
      const candidate = Buffer.from(signature, "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    } catch {
      return false;
    }
  });
  if (!valid) {
    const error = new Error("Invalid Stripe signature");
    error.status = 400;
    throw error;
  }
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    const error = new Error("Invalid Stripe JSON payload");
    error.status = 400;
    throw error;
  }
}
