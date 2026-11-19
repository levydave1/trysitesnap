import { normalizeEmailFlow } from "../server/email-export.js";
import { checkDataStore } from "../server/data-store-health.js";
import { sendEmailPreviewTests } from "../server/email-preview-test.js";
import { createRuntimeDependencies } from "../server/runtime.js";

function authorized(request) {
  const secret = process.env.EMAIL_PREVIEW_TEST_SECRET;
  return Boolean(secret) && request.headers?.authorization === `Bearer ${secret}`;
}

export default async function emailPreviewTestHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method === "GET" && request.query?.health === "data-store") {
    try {
      const result = await checkDataStore(createRuntimeDependencies({ airtable: true }));
      return response.status(200).json(result);
    } catch (error) {
      console.error(JSON.stringify({
        event: "data_store_health_failed",
        code: error.code || "DATA_STORE_UNAVAILABLE",
        message: String(error.message || "").slice(0, 200)
      }));
      return response.status(503).json({ success: false, code: "DATA_STORE_UNAVAILABLE" });
    }
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (!authorized(request)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });

  const flow = normalizeEmailFlow(request.body?.flow || process.env.EMAIL_EXPORT_FLOW);
  const dependencies = createRuntimeDependencies({
    airtable: true,
    emailExport: true,
    emailFlow: flow,
    notifications: true
  });
  try {
    const result = await sendEmailPreviewTests(dependencies, {
      recordIds: request.body?.record_ids,
      flow
    });
    console.log(JSON.stringify({ event: "scenario_02_preview_test", flow, sent: result.sent }));
    return response.status(200).json(result);
  } catch (error) {
    console.error(JSON.stringify({
      event: "scenario_02_preview_test_failed",
      code: error.code || "EMAIL_PREVIEW_TEST_FAILED",
      message: String(error.message || "").slice(0, 300)
    }));
    return response.status(500).json({ success: false, code: error.code || "EMAIL_PREVIEW_TEST_FAILED" });
  }
}
