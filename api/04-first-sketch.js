import { repairFirstSketchTest, resendFirstSketchTestEmail, runFirstSketch, runFirstSketchQueue, verifyTestOpenToken } from "../server/first-sketch.js";
import { createRuntimeDependencies } from "../server/runtime.js";

function authorized(request) {
  const secret = process.env.LOCAL_TELEGRAM_RELAY_SECRET;
  return Boolean(secret) && request.headers?.authorization === `Bearer ${secret}`;
}

export default async function firstSketchHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const origin = String(request.headers?.origin || "");
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Vary", "Origin");
  }
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (request.body?.event === "test_open") {
    const recordId = String(request.body?.record_id || "").trim();
    const businessName = String(request.body?.business_name || "").trim().slice(0, 200);
    const expiresAt = Number(request.body?.expires);
    const token = String(request.body?.token || "").trim();
    const valid = verifyTestOpenToken({
      secret: process.env.LOCAL_TELEGRAM_RELAY_SECRET,
      recordId,
      businessName,
      expiresAt,
      token
    });
    if (!valid) return response.status(401).json({ success: false, code: "INVALID_TEST_OPEN_TOKEN" });
    try {
      const dependencies = createRuntimeDependencies({ notifications: true });
      if (!dependencies.telegram) return response.status(503).json({ success: false, code: "TELEGRAM_NOT_CONFIGURED" });
      const openedAt = Number.isFinite(Date.parse(request.body?.opened_at))
        ? new Date(request.body.opened_at).toISOString()
        : new Date().toISOString();
      const pageUrl = /^https:\/\/[^\s]{1,500}$/i.test(String(request.body?.page_url || ""))
        ? String(request.body.page_url)
        : "";
      const sent = await dependencies.telegram.send([
        "[TEST 04] סקיצה נפתחה",
        businessName,
        openedAt,
        pageUrl
      ].filter(Boolean).join("\n"));
      return response.status(200).json({ success: true, testMode: true, telegramMessageId: sent?.message_id || null });
    } catch (error) {
      console.error(JSON.stringify({ event: "scenario_04_test_open_failed", message: String(error.message || "").slice(0, 300) }));
      return response.status(500).json({ success: false, code: "TEST_OPEN_FAILED" });
    }
  }
  if (!authorized(request)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });

  const testMode = request.body?.test === true;
  if (!testMode && process.env.SCENARIO_04_MODE !== "live") {
    return response.status(503).json({ success: false, code: "SCENARIO_04_DISABLED" });
  }
  try {
    const dependencies = createRuntimeDependencies({
      airtable: true,
      firstSketch: true,
      vercelDelivery: true,
      notifications: true
    });
    const result = testMode && request.body?.repair_url
      ? await repairFirstSketchTest(dependencies, {
          recordId: request.body?.record_id,
          sourceUrl: request.body?.repair_url
        })
      : testMode && request.body?.email_only === true
      ? await resendFirstSketchTestEmail(dependencies, {
          recordId: request.body?.record_id,
          businessName: request.body?.business_name,
          draftUrl: request.body?.draft_url
        })
      : request.body?.record_id
        ? await runFirstSketch(request.body.record_id, dependencies, {
            testMode,
            redirectEmail: !testMode && process.env.SCENARIO_04_EMAIL_MODE !== "customer"
          })
        : await runFirstSketchQueue(dependencies, { cutoverAt: process.env.SCENARIO_04_CUTOVER_AT });
    console.log(JSON.stringify({ event: "scenario_04_completed", ...result }));
    return response.status(200).json(result);
  } catch (error) {
    console.error(JSON.stringify({
      event: "scenario_04_failed",
      code: error.code || "SCENARIO_04_FAILED",
      message: String(error.message || "").slice(0, 300),
      upstreamStatus: error.upstreamStatus || null
    }));
    return response.status(500).json({ success: false, code: error.code || "SCENARIO_04_FAILED" });
  }
}
