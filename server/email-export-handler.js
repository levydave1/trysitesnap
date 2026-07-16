import { processEmailExportBatch, isLocalNoon } from "./email-export.js";
import { createRuntimeDependencies } from "./runtime.js";

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers?.authorization === `Bearer ${secret}`;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function emailExportHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (!authorized(request)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });

  const dependencies = createRuntimeDependencies({ airtable: true, emailExport: true, notifications: true });
  if (request.method === "GET" && !isLocalNoon(new Date(), dependencies.config.emailExport.timezone)) {
    return response.status(200).json({ success: true, skipped: true, reason: "outside_local_noon" });
  }
  try {
    const configuredLimit = number(process.env.EMAIL_EXPORT_MAX_RECORDS, dependencies.config.emailExport.maxRecords);
    const result = await processEmailExportBatch(dependencies, {
      maxRecords: number(request.body?.max_records, configuredLimit),
      recordId: request.body?.record_id || undefined,
      notify: request.body?.notify !== false
    });
    console.log(JSON.stringify({
      event: "scenario_02_completed",
      candidates: result.candidates,
      exported: result.exported,
      skipped: result.skipped,
      failed: result.failed
    }));
    return response.status(result.failed ? 207 : 200).json(result);
  } catch (error) {
    console.error(JSON.stringify({
      event: "scenario_02_failed",
      code: error.code || "SCENARIO_02_FAILED",
      message: String(error.message || "").slice(0, 300),
      upstreamStatus: error.upstreamStatus || null
    }));
    return response.status(500).json({ success: false, code: error.code || "SCENARIO_02_FAILED" });
  }
}

