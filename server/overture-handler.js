import { createPublicKey, verify as verifySignature } from "node:crypto";
import { createRuntimeDependencies } from "./runtime.js";
import {
  applyExternalVerificationResults,
  ingestOverturePlaces,
  pendingVerificationBatch
} from "./overture-leads.js";
import { verifyPendingEmails } from "./millionverifier.js";
import { normalizeEmailFlow, processEmailExportBatch } from "./email-export.js";

function text(value) {
  return String(value ?? "").trim();
}

function decodePart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function audienceMatches(value) {
  const audiences = Array.isArray(value) ? value : [value];
  return audiences.includes("sitesnap-overture");
}

export async function verifyGitHubOidcToken(token, options = {}) {
  try {
    const parts = text(token).split(".");
    if (parts.length !== 3) return false;
    const header = decodePart(parts[0]);
    const claims = decodePart(parts[1]);
    if (header.alg !== "RS256" || !text(header.kid)) return false;
    const nowSeconds = Math.floor(Number(options.now || Date.now()) / 1000);
    if (claims.iss !== "https://token.actions.githubusercontent.com") return false;
    if (!audienceMatches(claims.aud)) return false;
    if (claims.repository !== "levydave1/trysitesnap") return false;
    if (claims.ref !== "refs/heads/main") return false;
    if (!["workflow_dispatch", "schedule"].includes(claims.event_name)) return false;
    if (!text(claims.workflow_ref).endsWith("/.github/workflows/overture-leads.yml@refs/heads/main")) return false;
    if (!Number.isFinite(Number(claims.exp)) || nowSeconds >= Number(claims.exp)) return false;
    if (Number.isFinite(Number(claims.nbf)) && nowSeconds < Number(claims.nbf) - 30) return false;

    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl("https://token.actions.githubusercontent.com/.well-known/jwks", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return false;
    const jwks = await response.json();
    const jwk = (jwks.keys || []).find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return false;
    return verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2], "base64url")
    );
  } catch {
    return false;
  }
}

export async function authorizedOvertureRequest(request) {
  const secret = process.env.OVERTURE_INGEST_SECRET || process.env.CRON_SECRET;
  const authorization = text(request.headers?.authorization);
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice(7);
  if (secret && token === secret) return true;
  return verifyGitHubOidcToken(token);
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
  if (!await authorizedOvertureRequest(request)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });

  try {
    const action = text(request.body?.action || request.query?.action || "ingest").toLowerCase();
    const verificationDryRun = request.body?.dry_run === true;
    const emailFlow = normalizeEmailFlow(request.body?.flow || process.env.EMAIL_EXPORT_FLOW);
    const dependencies = createRuntimeDependencies({
      airtable: true,
      millionVerifier: action === "millionverifier" && !verificationDryRun,
      emailExport: action === "instantly_export",
      emailFlow
    });
    const data = dependencies.airtable;

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

    if (action === "millionverifier") {
      const recordId = text(request.body?.record_id || request.body?.recordId);
      if (!recordId && request.body?.confirm !== "VERIFY_PENDING_EMAILS") {
        return response.status(400).json({ success: false, code: "BATCH_CONFIRMATION_REQUIRED" });
      }
      const result = await verifyPendingEmails({
        config: dependencies.config,
        data,
        millionVerifier: dependencies.millionVerifier
      }, {
        recordId,
        limit: positiveInteger(request.body?.limit, dependencies.config.millionVerifier.batchLimit, 100),
        concurrency: positiveInteger(request.body?.concurrency, dependencies.config.millionVerifier.concurrency, 5),
        dryRun: verificationDryRun
      });
      console.log(JSON.stringify({ event: "millionverifier_batch_completed", ...result, results: undefined }));
      return response.status(200).json(result);
    }

    if (action === "instantly_export") {
      const recordId = text(request.body?.record_id || request.body?.recordId);
      if (!recordId || request.body?.confirm !== "EXPORT_ONE_VERIFIED_LEAD") {
        return response.status(400).json({ success: false, code: "SINGLE_EXPORT_CONFIRMATION_REQUIRED" });
      }
      const result = await processEmailExportBatch(dependencies, {
        recordId,
        maxRecords: 1,
        concurrency: 1,
        flow: emailFlow,
        notify: false
      });
      console.log(JSON.stringify({
        event: "single_instantly_export_completed",
        recordId,
        exported: result.exported,
        skipped: result.skipped,
        skippedUnverified: result.skippedUnverified,
        failed: result.failed
      }));
      return response.status(result.failed ? 207 : 200).json(result);
    }

    if (action === "migrate_schema") {
      if (typeof data.ensureLeadSchema !== "function") {
        return response.status(503).json({ success: false, code: "POSTGRES_SCHEMA_REQUIRED" });
      }
      const result = await data.ensureLeadSchema(dependencies.config.airtable.rawOutscraperTableId);
      console.log(JSON.stringify({ event: "overture_lead_schema_ready", ...result }));
      return response.status(200).json({ success: true, ...result });
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
