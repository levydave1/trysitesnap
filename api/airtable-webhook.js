import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createAirtableReconciliationDependencies,
  reconcileAirtable
} from "../server/airtable-reconciliation.js";

export const config = { api: { bodyParser: false } };

export function contentMacMatches(rawBody, received, secretBase64 = process.env.AIRTABLE_WEBHOOK_MAC_SECRET) {
  if (!received || !secretBase64) return false;
  const expected = `hmac-sha256=${createHmac("sha256", Buffer.from(secretBase64, "base64"))
    .update(rawBody)
    .digest("hex")}`;
  const receivedBuffer = Buffer.from(String(received));
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) {
      const error = new Error("Webhook body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  let rawBody;
  try {
    rawBody = await readRawBody(request);
  } catch (error) {
    return response.status(Number(error.status) || 400).json({ success: false, code: "INVALID_BODY" });
  }
  if (!contentMacMatches(rawBody, request.headers?.["x-airtable-content-mac"])) {
    return response.status(401).json({ success: false, code: "UNAUTHORIZED" });
  }

  try {
    const body = JSON.parse(rawBody.toString("utf8"));
    const result = await reconcileAirtable({
      ...createAirtableReconciliationDependencies(),
      dryRun: false
    });
    console.log(JSON.stringify({
      event: "airtable_webhook_reconciled",
      webhookId: body?.webhook?.id || null,
      ...result.totals
    }));
    return response.status(200).json({ success: true, runId: result.runId, totals: result.totals });
  } catch (error) {
    console.error(JSON.stringify({
      event: "airtable_webhook_failed",
      code: error.code || "AIRTABLE_WEBHOOK_FAILED",
      message: String(error.message || "").slice(0, 300)
    }));
    return response.status(500).json({ success: false, code: "AIRTABLE_WEBHOOK_FAILED" });
  }
}
