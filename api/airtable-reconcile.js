import {
  createAirtableReconciliationDependencies,
  reconcileAirtable
} from "../server/airtable-reconciliation.js";

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers?.authorization === `Bearer ${secret}`;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (!authorized(request)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });

  try {
    const dryRun = request.method === "POST"
      && (request.body?.dry_run === true || request.query?.dry_run === "1");
    const result = await reconcileAirtable({
      ...createAirtableReconciliationDependencies(),
      dryRun
    });
    if (!dryRun && process.env.AIRTABLE_WEBHOOK_ID) {
      const { airtable } = createAirtableReconciliationDependencies();
      try {
        await airtable.refreshWebhook(process.env.AIRTABLE_WEBHOOK_ID);
      } catch (error) {
        console.error(JSON.stringify({
          event: "airtable_webhook_refresh_failed",
          message: String(error.message || "").slice(0, 300)
        }));
      }
    }
    console.log(JSON.stringify({ event: "airtable_reconciliation_completed", ...result.totals, dryRun }));
    return response.status(200).json({ success: true, ...result });
  } catch (error) {
    const status = Number(error.status) || 500;
    console.error(JSON.stringify({
      event: "airtable_reconciliation_failed",
      code: error.code || "AIRTABLE_RECONCILIATION_FAILED",
      message: String(error.message || "").slice(0, 300)
    }));
    return response.status(status).json({
      success: false,
      code: error.code || "AIRTABLE_RECONCILIATION_FAILED"
    });
  }
}
