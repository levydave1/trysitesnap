import { enrichOvertureEmails, resetFoundEnrichment } from "./email-enrichment.js";
import { authorizedOvertureRequest } from "./overture-handler.js";
import { createRuntimeDependencies } from "./runtime.js";

function text(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(maximum, number);
}

export async function enrichmentHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (!await authorizedOvertureRequest(request)) {
    return response.status(401).json({ success: false, code: "UNAUTHORIZED" });
  }

  try {
    const dependencies = createRuntimeDependencies({ airtable: true });
    if (text(request.body?.action).toLowerCase() === "reset_found") {
      const result = await resetFoundEnrichment({
        config: dependencies.config,
        data: dependencies.airtable
      }, { dryRun: request.body?.dry_run === true });
      console.log(JSON.stringify({ event: "overture_email_enrichment_reset", ...result }));
      return response.status(200).json(result);
    }
    const result = await enrichOvertureEmails({
      config: dependencies.config,
      data: dependencies.airtable
    }, {
      limit: positiveInteger(request.body?.limit, 15, 25),
      concurrency: positiveInteger(request.body?.concurrency, 3, 5),
      dryRun: request.body?.dry_run === true
    });
    console.log(JSON.stringify({
      event: "overture_email_enrichment_completed",
      selected: result.selected,
      found: result.found,
      notFound: result.notFound,
      duplicates: result.duplicates,
      errors: result.errors,
      updated: result.updated,
      dryRun: result.dryRun
    }));
    return response.status(200).json(result);
  } catch (error) {
    console.error(JSON.stringify({
      event: "overture_email_enrichment_failed",
      code: error.code || "EMAIL_ENRICHMENT_FAILED",
      message: text(error.message).slice(0, 300)
    }));
    return response.status(500).json({ success: false, code: error.code || "EMAIL_ENRICHMENT_FAILED" });
  }
}
