import { config as appConfig } from "../server/config.js";
import { createRuntimeDependencies } from "../server/runtime.js";
import { processOutscraperWebhook, verifyOutscraperWebhook } from "../server/outscraper-webhook.js";
import { readRawBody } from "../server/stripe-webhook.js";

export const config = { api: { bodyParser: false } };

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ received: false, code: "METHOD_NOT_ALLOWED" });
  }
  try {
    const rawBody = await readRawBody(request, appConfig.bodyBytes);
    const event = verifyOutscraperWebhook(
      rawBody,
      request.headers["x-hub-signature-256"],
      process.env.OUTSCRAPER_API_KEY
    );
    const dependencies = createRuntimeDependencies({ airtable: true, outscraper: true, notifications: true });
    const result = await processOutscraperWebhook(event, dependencies);
    return response.status(200).json({ received: true, result });
  } catch (error) {
    const status = Number(error.status) || 500;
    console.error(JSON.stringify({
      event: "outscraper_webhook_failed",
      status,
      code: error.code || "INTERNAL_ERROR",
      message: String(error.message || "").slice(0, 300)
    }));
    return response.status(status).json({ received: false, code: status === 400 ? "INVALID_WEBHOOK" : "PROCESSING_FAILED" });
  }
}
