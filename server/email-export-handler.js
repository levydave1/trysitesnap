import { processEmailExportBatch, isLocalNoon, normalizeEmailFlow } from "./email-export.js";
import { recoverLatestOutscraperImport } from "./outscraper-webhook.js";
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

  const flow = normalizeEmailFlow(request.body?.flow || process.env.EMAIL_EXPORT_FLOW);
  const dependencies = createRuntimeDependencies({ airtable: true, outscraper: true, emailExport: true, emailFlow: flow, notifications: true });
  try {
    const localNoon = isLocalNoon(new Date(), dependencies.config.emailExport.timezone);
    if (request.method === "GET" || request.body?.recover_outscraper === true) {
      const recovery = await recoverLatestOutscraperImport(dependencies, { notify: true });
      console.log(JSON.stringify({
        event: "outscraper_daily_recovery_completed",
        recovered: recovery.recovered,
        inspected: recovery.inspected,
        created: recovery.result?.created || 0
      }));
      if (request.method === "GET" && !localNoon) {
        return response.status(200).json({
          success: true,
          recoveryOnly: true,
          recovered: recovery.recovered,
          inspected: recovery.inspected,
          created: recovery.result?.created || 0
        });
      }
    }
    const configuredLimit = number(process.env.EMAIL_EXPORT_MAX_RECORDS, dependencies.config.emailExport.maxRecords);
    const result = await processEmailExportBatch(dependencies, {
      maxRecords: number(request.body?.max_records, configuredLimit),
      recordId: request.body?.record_id || undefined,
      flow,
      notify: request.body?.notify !== false
    });
    console.log(JSON.stringify({
      event: "scenario_02_completed",
      flow: result.flow,
      candidates: result.candidates,
      exported: result.exported,
      skipped: result.skipped,
      failed: result.failed,
      failures: result.results.filter((item) => item.status === "failed").map((item) => ({
        recordId: item.recordId,
        stage: item.stage,
        code: item.code,
        upstreamStatus: item.upstreamStatus
      })).slice(0, 20)
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
