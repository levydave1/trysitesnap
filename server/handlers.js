const domainPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.[a-z]{2,}$/i;
const recordIdPattern = /^rec[a-zA-Z0-9]{14,}$/;

export class RequestError extends Error {
  constructor(message, status = 400, code = "INVALID_REQUEST") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireText(value, name, max = 500) {
  const text = String(value ?? "").trim();
  if (!text) throw new RequestError(`Missing ${name}`);
  if (text.length > max) throw new RequestError(`${name} is too long`);
  return text;
}

function requireRecordId(value) {
  const recordId = requireText(value, "record_id", 64);
  if (!recordIdPattern.test(recordId)) throw new RequestError("Invalid record_id");
  return recordId;
}

function requireDomain(value) {
  const domain = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  if (!domainPattern.test(domain)) throw new RequestError("Invalid domain");
  return domain;
}

function price(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

export function availabilityFromCloudflare(domains, limits) {
  const primary = domains[0] || {};
  return {
    available:
      primary.registrable === true &&
      primary.tier === "standard" &&
      price(primary.pricing?.registration_cost) <= limits.registrationMaxUsd &&
      price(primary.pricing?.renewal_cost) <= limits.renewalMaxUsd,
    alternatives: domains.slice(1).map((item) => item?.name).filter(Boolean)
  };
}

export async function domainAvailability(body, { cloudflare, config }) {
  const candidates = Array.isArray(body?.domains)
    ? body.domains
    : body?.domain
      ? [body.domain]
      : [];
  const domains = [...new Set(candidates.map(requireDomain))];
  if (!domains.length) throw new RequestError("Missing domains");
  if (domains.length > 20) throw new RequestError("Too many domains");
  return availabilityFromCloudflare(await cloudflare.checkDomains(domains), config.cloudflare);
}

function normalizeZip(value) {
  const zip = requireText(value, "registrant_zip", 10);
  if (!/^\d{5}(?:-\d{4})?$/.test(zip)) throw new RequestError("Invalid registrant_zip");
  return Number(zip.replace("-", ""));
}

export async function domainRegistration(body, { airtable, config }) {
  const field = config.airtable.fields;
  const stateSource = config.compatibility.registrationStateSource;
  const recordId = requireRecordId(body?.record_id);
  const fields = {
    [field.registrantZip]: normalizeZip(body?.registrant_zip),
    [field.registrantState]: requireText(body?.[stateSource], stateSource, 100),
    [field.registrantFullName]: requireText(body?.registrant_full_name, "registrant_full_name"),
    [field.registrantEmail]: requireText(body?.registrant_email, "registrant_email"),
    [field.consent]: String(Boolean(body?.consent)),
    [field.selectedDomain]: requireDomain(body?.selected_domain),
    [field.registrantCity]: requireText(body?.registrant_city, "registrant_city"),
    [field.registrantAddress]: requireText(body?.registrant_address, "registrant_address"),
    [field.businessName]: requireText(body?.business_name, "business_name"),
    [field.registrantPhone]: requireText(body?.registrant_phone, "registrant_phone", 40),
    [field.paymentStatus]: config.compatibility.paymentStatusValue,
    [field.registrantCountry]: requireText(body?.registrant_country, "registrant_country", 100)
  };
  await airtable.updateRecord(recordId, fields);
  return { success: true };
}

export async function existingDomain(input, { airtable, config }) {
  const recordId = requireRecordId(input?.record_id);
  const domain = requireDomain(input?.domain);
  await airtable.updateRecord(recordId, { [config.airtable.fields.existingDomain]: domain });
  return { success: true };
}

