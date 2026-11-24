const VERIFIED_STATUSES = new Set(["GOOD", "OK", "VALID", "DELIVERABLE"]);
const LEGACY_OUTSCRAPER_STATUSES = new Set(["RECEIVING", "VALID", "DELIVERABLE"]);

function text(value) {
  return String(value ?? "").trim();
}

function normalizedBoolean(value) {
  const normalized = text(value).toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n", ""].includes(normalized)) return false;
  return null;
}

function verificationAgeIsSafe(value, now, maxAgeDays) {
  const checkedAt = new Date(value);
  if (!Number.isFinite(checkedAt.getTime())) return false;
  const ageMs = now.getTime() - checkedAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

export function emailExportEligibility(record, options = {}) {
  const fields = record?.fields || {};
  const source = text(fields["Source System"]).toLowerCase();
  const status = text(fields["Email Validation Status"]).toUpperCase();

  // Existing Outscraper rows were admitted only after Outscraper's own
  // RECEIVING/VALID/DELIVERABLE gate. Preserve that already-verified backlog.
  if (source === "outscraper") {
    if (!status || LEGACY_OUTSCRAPER_STATUSES.has(status)) return { eligible: true, reason: "LEGACY_VERIFIED" };
    return { eligible: false, reason: "LEGACY_EMAIL_NOT_VERIFIED" };
  }

  // Overture is discovery data, not mailbox verification. New rows must never
  // reach Instantly until an external batch result explicitly approves them.
  if (source === "overture") {
    if (text(fields["Lead Decision"]).toLowerCase() !== "approved") {
      return { eligible: false, reason: "PENDING_EXTERNAL_VERIFICATION" };
    }
    if (normalizedBoolean(fields["Email Eligible"]) !== true) {
      return { eligible: false, reason: "EMAIL_NOT_ELIGIBLE" };
    }
    if (!VERIFIED_STATUSES.has(status)) {
      return { eligible: false, reason: "EMAIL_NOT_VERIFIED" };
    }
    if (!text(fields["Email Validation Provider"])) {
      return { eligible: false, reason: "VERIFICATION_PROVIDER_MISSING" };
    }
    if (normalizedBoolean(fields["Email Catch All"]) === true) {
      return { eligible: false, reason: "CATCH_ALL_NOT_ALLOWED" };
    }
    if (normalizedBoolean(fields["Email Disposable"]) === true) {
      return { eligible: false, reason: "DISPOSABLE_NOT_ALLOWED" };
    }
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const maxAgeDays = Math.max(1, Number(options.maxAgeDays) || 30);
    if (!verificationAgeIsSafe(fields["Email Validation Checked At"], now, maxAgeDays)) {
      return { eligible: false, reason: "VERIFICATION_EXPIRED" };
    }
  }

  // Other existing sources retain their current behavior. The strict external
  // gate applies to every newly discovered Overture lead.
  return { eligible: true, reason: "EXISTING_SOURCE" };
}

export const approvedExternalVerificationStatuses = VERIFIED_STATUSES;
