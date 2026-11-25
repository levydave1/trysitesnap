import { applyExternalVerificationResults, validateEmailLocally } from "./overture-leads.js";

const CURRENT_GOOD = new Set(["GOOD", "OK"]);

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function truthy(value) {
  return ["1", "true", "yes", "y"].includes(lower(value));
}

function normalizedStatus(value) {
  return text(value).toUpperCase().replace(/[ -]+/g, "_");
}

function currentVerification(fields, email, now, maxAgeDays) {
  if (lower(fields.Email) !== email) return null;
  const status = normalizedStatus(fields["Email Validation Status"]);
  const checkedAt = Date.parse(text(fields["Email Validation Checked At"]));
  if (!CURRENT_GOOD.has(status) || !text(fields["Email Validation Provider"]) || !Number.isFinite(checkedAt)) return null;
  if (now.getTime() - checkedAt < 0 || now.getTime() - checkedAt > maxAgeDays * 86_400_000) return null;
  if (truthy(fields["Email Catch All"]) || truthy(fields["Email Disposable"]) || truthy(fields["Email Risky"])) return null;
  return { status, checkedAt: new Date(checkedAt).toISOString() };
}

function pendingFields(now, reason, details, attempts, raw = "") {
  const fields = {
    "Email Eligible": "no",
    "Email Status": "pending_external_verification",
    "Email Verification Attempts": attempts,
    "Email Verification Last Attempt At": now.toISOString(),
    "Email Verification Error": details,
    "Lead Status": "enriched",
    "Lead Status Updated At": now.toISOString(),
    "Lead Decision": "pending_verification",
    "Lead Decision Reason": reason,
    "Lead Rejection Reason": ""
  };
  if (raw) fields["Email Validation Raw JSON"] = raw;
  return fields;
}

function rejectedFields(now, reason, details, attempts, extra = {}) {
  return {
    "Email Eligible": "no",
    "Email Status": "rejected",
    "Email Verification Attempts": attempts,
    "Email Verification Last Attempt At": now.toISOString(),
    "Email Verification Error": "",
    "Email Validation Details": details,
    "Lead Status": "rejected",
    "Lead Status Updated At": now.toISOString(),
    "Lead Decision": "rejected",
    "Lead Decision Reason": reason,
    "Lead Rejection Reason": reason,
    ...extra
  };
}

function errorReason(error) {
  if (error?.code === "MILLIONVERIFIER_TIMEOUT") return "MILLIONVERIFIER_TIMEOUT";
  if (error?.code === "MILLIONVERIFIER_RATE_LIMIT") return "MILLIONVERIFIER_RATE_LIMIT";
  return "MILLIONVERIFIER_API_ERROR";
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function verifyPendingEmails(dependencies, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const settings = dependencies.config.millionVerifier;
  const maxAgeDays = Math.max(1, Number(options.maxAgeDays) || settings.maxAgeDays);
  const tableId = dependencies.config.airtable.rawOutscraperTableId;
  const fields = [
    "Email", "Business Name", "Source System", "Lead Decision", "Lead Status",
    "Email Validation Status", "Email Validation Provider", "Email Validation Checked At",
    "Email Validation Raw JSON", "Email Catch All", "Email Disposable", "Email Risky",
    "Email Verification Attempts"
  ];
  const records = options.records || await dependencies.data.listRecords(tableId, { fields });
  const requestedId = text(options.recordId);
  const requested = requestedId ? records.filter((record) => record.id === requestedId) : records;
  const sourceSystem = lower(options.sourceSystem) || "overture";
  const hasEligibleRecordFilter = options.eligibleRecordIds instanceof Set || Array.isArray(options.eligibleRecordIds);
  const eligibleRecordIds = options.eligibleRecordIds instanceof Set
    ? options.eligibleRecordIds
    : new Set(Array.isArray(options.eligibleRecordIds) ? options.eligibleRecordIds.map(text) : []);
  if (requestedId && !requested.length) {
    const error = new Error(`Lead ${requestedId} was not found`);
    error.code = "LEAD_NOT_FOUND";
    throw error;
  }
  const emailOwners = new Map();
  for (const record of records) {
    const email = lower(record.fields?.Email);
    if (!email) continue;
    if (!emailOwners.has(email)) emailOwners.set(email, []);
    emailOwners.get(email).push(record.id);
  }
  const limit = requestedId ? 1 : Math.max(1, Math.min(100, Number(options.limit) || settings.batchLimit));
  const selected = requested
    .filter((record) => lower(record.fields?.["Source System"]) === sourceSystem)
    .filter((record) => hasEligibleRecordFilter
      ? eligibleRecordIds.has(record.id)
      : lower(record.fields?.["Lead Decision"]) === "pending_verification")
    .slice(0, limit);
  const summary = {
    success: true,
    dryRun: Boolean(options.dryRun),
    selected: selected.length,
    apiCalls: 0,
    reused: 0,
    approved: 0,
    rejected: 0,
    errors: 0,
    updated: 0,
    results: []
  };

  await mapConcurrent(selected, Math.max(1, Math.min(5, Number(options.concurrency) || settings.concurrency)), async (record) => {
    const recordFields = record.fields || {};
    const email = lower(recordFields.Email);
    const attempts = Math.max(0, Number(recordFields["Email Verification Attempts"]) || 0) + 1;
    let updates;
    let outcome;

    if (!email) {
      updates = rejectedFields(now, "EMAIL_MISSING", "No email address to verify", attempts);
      outcome = "rejected";
    } else if ((emailOwners.get(email) || []).length > 1) {
      updates = rejectedFields(now, "DUPLICATE_EMAIL", "Email already belongs to another lead", attempts);
      outcome = "rejected";
    } else {
      const local = await validateEmailLocally(email, options.dns);
      if (!local.valid) {
        const reason = local.reason || "LOCAL_EMAIL_CHECK_FAILED";
        updates = rejectedFields(now, reason, "Free syntax, disposable-domain and mail-DNS checks did not pass", attempts, {
          "Email Disposable": local.disposable ? "yes" : "no"
        });
        outcome = "rejected";
      } else {
        const reusable = currentVerification(recordFields, email, now, maxAgeDays);
        if (reusable) {
          updates = {
            "Email Eligible": "yes",
            "Email Status": "verified",
            "Email Verification Reusable": "yes",
            "Email Verification Error": "",
            "Lead Status": "approved",
            "Lead Status Updated At": now.toISOString(),
            "Lead Decision": "approved",
            "Lead Decision Reason": "CURRENT_EXTERNAL_VERIFICATION_REUSED",
            "Lead Rejection Reason": ""
          };
          summary.reused += 1;
          outcome = "approved";
        } else if (options.dryRun) {
          outcome = "would_verify";
        } else {
          try {
            summary.apiCalls += 1;
            const raw = await dependencies.millionVerifier.verifyEmail(email);
            const status = normalizedStatus(raw.result || raw.quality);
            if (status === "ERROR" || text(raw.error)) {
              updates = pendingFields(now, "MILLIONVERIFIER_API_ERROR", text(raw.error) || "MillionVerifier returned an error", attempts, JSON.stringify(raw));
              outcome = "error";
            } else {
              await applyExternalVerificationResults([{
                record_id: record.id,
                email,
                status,
                provider: "millionverifier",
                checked_at: now.toISOString(),
                details: text(raw.subresult || raw.quality),
                catch_all: status === "CATCH_ALL",
                disposable: status === "DISPOSABLE",
                risky: ["CATCH_ALL", "UNKNOWN"].includes(status),
                raw_response: raw
              }], dependencies, {
                now,
                records: [record],
                allowedSourceSystems: [sourceSystem]
              });
              summary.updated += 1;
              outcome = CURRENT_GOOD.has(status) ? "approved" : "rejected";
              updates = null;
            }
          } catch (error) {
            const reason = errorReason(error);
            const raw = error?.upstreamPayload ? JSON.stringify(error.upstreamPayload) : "";
            updates = pendingFields(now, reason, text(error.message).slice(0, 300), attempts, raw);
            outcome = "error";
          }
        }
      }
    }

    if (updates && !options.dryRun) {
      await dependencies.data.updateRecordInTable(tableId, record.id, updates);
      summary.updated += 1;
    }
    if (outcome === "approved") summary.approved += 1;
    if (outcome === "rejected") summary.rejected += 1;
    if (outcome === "error") summary.errors += 1;
    summary.results.push({ recordId: record.id, email, outcome, reason: updates?.["Lead Decision Reason"] || "MILLIONVERIFIER_RESULT_APPLIED" });
  });

  return summary;
}
