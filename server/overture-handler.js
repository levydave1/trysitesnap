import { createRuntimeDependencies } from "./runtime.js";
import {
  applyExternalVerificationResults,
  ingestOverturePlaces,
  pendingVerificationBatch
} from "./overture-leads.js";

function text(value) {
  return String(value ?? "").trim();
}

function authorized(request) {
  const secret = process.env.OVERTURE_INGEST_SECRET || process.env.CRON_SECRET;
  return Boolean(secret) && request.headers?.authorization === `Bearer ${secret}`;
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(maximum, number);
}

export async function overtureHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (!authorized(request)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });

  try {
    const dependencies = createRuntimeDependencies({ airtable: true });
    const data = dependencies.airtable;
    const action = text(request.body?.action || request.query?.action || "ingest").toLowerCase();

    if (request.method === "GET") {
      const records = await data.listRecords(dependencies.config.airtable.rawOutscraperTableId, {
        fields: ["Email", "Business Name", "Website", "Source System", "Lead Decision"]
      });
      const batch = pendingVerificationBatch(records, positiveInteger(request.query?.limit, 500, 2000));
      return response.status(200).json({
        success: true,
        action: "verification_batch",
        count: batch.length,
        leads: batch
      });
    }

    if (action === "verification_results") {
      const results = Array.isArray(request.body?.results) ? request.body.results : [];
      if (!results.length || results.length > 2000) {
        return response.status(400).json({ success: false, code: "INVALID_VERIFICATION_RESULTS" });
      }
      const result = await applyExternalVerificationResults(results, {
        config: dependencies.config,
        data
      }, { dryRun: request.body?.dry_run === true });
      console.log(JSON.stringify({ event: "overture_verification_results_applied", ...result }));
      return response.status(200).json(result);
    }

    const places = Array.isArray(request.body?.places) ? request.body.places : [];
    if (!places.length || places.length > 50) {
      return response.status(400).json({ success: false, code: "INVALID_OVERTURE_BATCH", maximum: 50 });
    }
    const result = await ingestOverturePlaces(places, {
      config: dependencies.config,
      data
    }, {
      runName: text(request.body?.run_name),
      minimumScore: request.body?.minimum_score,
      dryRun: request.body?.dry_run === true
    });
    console.log(JSON.stringify({
      event: "overture_batch_processed",
      inspected: result.inspected,
      accepted: result.accepted,
      created: result.created,
      pendingExternalVerification: result.pendingExternalVerification,
      rejectionCounts: result.rejectionCounts
    }));
    return response.status(200).json(result);
  } catch (error) {
    console.error(JSON.stringify({
      event: "overture_pipeline_failed",
      code: error.code || "OVERTURE_PIPELINE_FAILED",
      message: text(error.message).slice(0, 300)
    }));
    return response.status(500).json({ success: false, code: error.code || "OVERTURE_PIPELINE_FAILED" });
  }
}
