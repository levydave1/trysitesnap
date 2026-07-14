import { timingSafeEqual } from "node:crypto";
import { createRuntimeDependencies } from "../server/runtime.js";
import { processDomainPurchase, processSiteDelivery } from "../server/workflows.js";

function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 20 && timingSafeEqual(a, b);
}

function fakeEvent({ id, clientReferenceId, paymentLink }) {
  return {
    id,
    type: "checkout.session.completed",
    data: { object: {
      id: `cs_test_${id}`,
      payment_status: "paid",
      client_reference_id: clientReferenceId,
      payment_link: paymentLink,
      customer_details: { email: "migration-test@sitesnappreview.com" }
    } }
  };
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  if (process.env.ENABLE_MIGRATION_TESTS !== "true") return response.status(404).json({ success: false, code: "NOT_FOUND" });
  if (!sameSecret(request.headers["x-sitesnap-test-secret"], process.env.MIGRATION_TEST_SECRET)) {
    return response.status(401).json({ success: false, code: "UNAUTHORIZED" });
  }
  const recordId = String(request.body?.record_id || "");
  if (recordId !== process.env.MIGRATION_TEST_RECORD_ID) {
    return response.status(400).json({ success: false, code: "TEST_RECORD_REQUIRED" });
  }
  try {
    if (request.body?.action === "domain-check") {
      const domain = String(request.body?.domain || "").toLowerCase();
      const event = fakeEvent({
        id: `evt_migration_domain_${Date.now()}`,
        clientReferenceId: `${recordId}__${domain.replaceAll(".", "_dot_")}`,
        paymentLink: "plink_1TQcHdAwnz8IxQfi9Xsc7aed"
      });
      const result = await processDomainPurchase(event, createRuntimeDependencies({
        airtable: true,
        cloudflare: true,
        notifications: true
      }), { testMode: true });
      return response.status(200).json({ success: true, result });
    }
    if (request.body?.action === "site-delivery") {
      const domain = String(request.body?.domain || "").toLowerCase();
      if (!domain.endsWith(".trysitesnap.com")) {
        return response.status(400).json({ success: false, code: "TEST_SUBDOMAIN_REQUIRED" });
      }
      const event = fakeEvent({
        id: `evt_migration_delivery_${Date.now()}`,
        clientReferenceId: recordId,
        paymentLink: "plink_1TQcJKAwnz8IxQfivOpFoUIo"
      });
      const result = await processSiteDelivery(event, createRuntimeDependencies({
        airtable: true,
        vercelDelivery: true,
        notifications: true
      }), {
        testMode: true,
        plan: "subdomain",
        recordId,
        domain,
        skipNotifications: true,
        htmlSource: JSON.stringify({
          name: "sitesnap-migration-verification",
          files: [{
            file: "index.html",
            data: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>SiteSnap migration verified</title></head><body style=\"font-family:system-ui;text-align:center;padding:15vh 20px\"><h1>SiteSnap migration verified</h1><p>Scenario 10 delivered this page without Make.</p></body></html>"
          }]
        })
      });
      return response.status(200).json({ success: true, result });
    }
    return response.status(400).json({ success: false, code: "UNKNOWN_ACTION" });
  } catch (error) {
    console.error(JSON.stringify({ event: "migration_test_failed", message: String(error.message || "").slice(0, 300) }));
    return response.status(500).json({ success: false, code: "TEST_FAILED", message: String(error.message || "").slice(0, 300) });
  }
}
