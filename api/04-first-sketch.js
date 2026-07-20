import { resendFirstSketchTestEmail, runFirstSketch, runFirstSketchQueue } from "../server/first-sketch.js";
import { createRuntimeDependencies } from "../server/runtime.js";

function authorized(request) {
  const secret = process.env.LOCAL_TELEGRAM_RELAY_SECRET;
  return Boolean(secret) && request.headers?.authorization === `Bearer ${secret}`;
}

export default async function firstSketchHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
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
    const result = testMode && request.body?.email_only === true
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
