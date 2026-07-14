import { config as appConfig } from "../server/config.js";
import { createRuntimeDependencies } from "../server/runtime.js";
import { readRawBody, verifyStripeEvent } from "../server/stripe-webhook.js";
import { processDomainPurchase, processSiteDelivery } from "../server/workflows.js";

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
    const event = verifyStripeEvent(
      rawBody,
      request.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET,
      appConfig.stripe.webhookToleranceSeconds
    );
    const dependencies = createRuntimeDependencies({
      airtable: true,
      cloudflare: true,
      vercelDelivery: true,
      notifications: true
    });
    const [domainPurchase, siteDelivery] = await Promise.all([
      processDomainPurchase(event, dependencies),
      processSiteDelivery(event, dependencies)
    ]);
    return response.status(200).json({ received: true, event: event.id, domainPurchase, siteDelivery });
  } catch (error) {
    const status = Number(error.status) || 500;
    console.error(JSON.stringify({
      event: "stripe_webhook_failed",
      status,
      code: error.code || "INTERNAL_ERROR",
      message: String(error.message || "").slice(0, 300)
    }));
    return response.status(status).json({ received: false, code: status === 400 ? "INVALID_WEBHOOK" : "PROCESSING_FAILED" });
  }
}
