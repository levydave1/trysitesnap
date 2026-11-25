import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isValidLeadEmail } from "./email-export.js";

const TARGET_CATEGORY_PATTERN = /(?:roof|plumb|hvac|heating|air_condition|electric|landscap|lawn|tree_service|arborist|pest|garage_door|remodel|renovat|general_contractor|paint|floor|tile|fenc|deck|gutter|window|door|locksmith|cleaning|carpet|pressure_wash|pool|spa|masonry|concrete|handyman|appliance_repair|insulation|solar|security_system|septic|foundation|chimney|irrigation|snow_removal|water_damage|fire_damage|mold_remediation|restoration|junk_removal|moving|storage|auto_repair|body_shop|towing|detail|mobile_mechanic|salon|barber|nail|massage|chiropract|dental|physical_therap|veterinar|pet_groom|photograph|event_plann|cater|bakery|restaurant|account|bookkeep|insurance|real_estate|property_manag|lawyer|law_firm)/i;

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "tempmail.com",
  "yopmail.com"
]);

const SOCIAL_WEBSITE_HOSTS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "yelp.com"
]);

const BUILDER_HOST_PARTS = [
  "wixsite.com",
  "godaddysites.com",
  "sites.google.com",
  "weebly.com",
  "webflow.io",
  "square.site"
];

const CHAIN_OR_FRANCHISE_PATTERN = /(?:ace_handyman|anytime_fitness|budget_blinds|burger_king|century_21|chem[_-]dry|chick[_-]fil[_-]a|coldwell_banker|domino'?s|dunkin|five_guys|great_clips|home_depot|ihop|jimmy_john|keller_williams|kfc|little_caesars|lowe'?s|mcdonald|merry_maids|molly_maid|mr\.?_handyman|mr\.?_rooter|one_hour_heating|orkin|papa_john|pizza_hut|re[_\/]max|roto[_-]rooter|servpro|subway|taco_bell|terminix|the_grounds_guys|trugreen|wendy'?s)/i;

function text(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstObject(value) {
  if (Array.isArray(value)) return asObject(value.find((item) => item && typeof item === "object"));
  return asObject(value);
}

function stringValues(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    return [item.value, item.email, item.url, item.phone, item.number].map(text).filter(Boolean);
  }).map(text).filter(Boolean);
}

function firstString(value) {
  return stringValues(value)[0] || "";
}

function normalizedWebsite(value) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function websiteKind(website) {
  if (!website) return "missing";
  try {
    const host = new URL(website).hostname.toLowerCase().replace(/^www\./, "");
    if (SOCIAL_WEBSITE_HOSTS.has(host) || [...SOCIAL_WEBSITE_HOSTS].some((item) => host.endsWith(`.${item}`))) return "social";
    if (BUILDER_HOST_PARTS.some((part) => host === part || host.endsWith(`.${part}`))) return "hosted_builder";
    return "owned";
  } catch {
    return "missing";
  }
}

function emailDomain(email) {
  return text(email).toLowerCase().split("@")[1] || "";
}

function addressFromPlace(place) {
  return firstObject(place.address || place.addresses);
}

function publicDescription(place) {
  return text(place.description || place.public_description || place.brand?.name || place.brand);
}

function brandName(place) {
  const brand = asObject(place.brand);
  return text(brand.name || asObject(brand.names).primary || place.brand_name);
}

function explicitChainOrFranchise(place) {
  return place.is_chain === true
    || place.is_franchise === true
    || place.chain === true
    || place.franchise === true
    || text(place.chain_id)
    || text(place.franchise_id);
}

function stableFallbackId({ name, address, city, state, phone, website }) {
  const identity = [name, address, city, state, phone, website]
    .map((value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
    .join("|");
  if (!name || ![address, city, phone, website].some((value) => text(value))) return "";
  return `dedupe-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function normalizeOverturePlace(place) {
  place = asObject(place);
  const names = asObject(place.names);
  const taxonomy = asObject(place.taxonomy);
  const address = addressFromPlace(place);
  const name = text(place.name || names.primary || place.business_name);
  const category = text(place.category || taxonomy.primary || place.primary_category);
  const emails = stringValues(place.emails || place.email).map((email) => email.toLowerCase());
  const websites = stringValues(place.websites || place.website).map(normalizedWebsite).filter(Boolean);
  const socials = stringValues(place.socials || place.social);
  const country = text(place.country || address.country || address.country_code).toUpperCase();
  const normalized = {
    id: text(place.id || place.place_id),
    name,
    category,
    confidence: Number(place.confidence) || 0,
    operatingStatus: text(place.operating_status || place.operatingStatus).toUpperCase(),
    country,
    address: text(address.freeform || address.address || place.formatted_address),
    city: text(address.locality || address.city),
    state: text(address.region || address.state),
    postalCode: text(address.postcode || address.postal_code),
    emails,
    website: websites[0] || "",
    phone: firstString(place.phones || place.phone),
    socials,
    brandName: brandName(place),
    chainOrFranchise: Boolean(explicitChainOrFranchise(place)),
    description: publicDescription(place),
    raw: place
  };
  if (!normalized.id) normalized.id = stableFallbackId(normalized);
  return normalized;
}

async function hasAddressRecord(domain, dns = {}) {
  const resolvers = [dns.resolve4 || resolve4, dns.resolve6 || resolve6];
  for (const resolver of resolvers) {
    try {
      if ((await resolver(domain)).length) return true;
    } catch {}
  }
  return false;
}

export async function validateEmailLocally(email, dns = {}) {
  const normalized = text(email).toLowerCase();
  if (!isValidLeadEmail(normalized)) return { valid: false, reason: "INVALID_SYNTAX" };
  const domain = emailDomain(normalized);
  if (DISPOSABLE_DOMAINS.has(domain)) return { valid: false, reason: "DISPOSABLE_DOMAIN", disposable: true };
  try {
    const records = await (dns.resolveMx || resolveMx)(domain);
    if (records.some((record) => Number.isFinite(Number(record.priority)) && text(record.exchange))) {
      return { valid: true, reason: "MX_FOUND", domain, disposable: false };
    }
  } catch {}
  if (await hasAddressRecord(domain, dns)) {
    return { valid: true, reason: "ADDRESS_FALLBACK", domain, disposable: false };
  }
  return { valid: false, reason: "NO_MAIL_DNS", domain, disposable: false };
}

export function scoreOvertureLead(place, emailCheck = { valid: false }) {
  const websiteType = websiteKind(place.website);
  let score = 0;
  if (TARGET_CATEGORY_PATTERN.test(place.category)) score += 25;
  score += Math.round(Math.min(1, Math.max(0, place.confidence)) * 15);
  if (place.emails.length) score += 20;
  if (emailCheck.valid) score += 10;
  if (websiteType === "missing" || websiteType === "social") score += 10;
  else if (websiteType === "hosted_builder") score += 8;
  else score += 4;
  if (place.phone) score += 5;
  if (place.address || (place.city && place.state)) score += 8;
  if (place.socials.length) score += 4;
  if (place.description) score += 3;
  return Math.min(100, score);
}

function chainOrFranchiseReason(place) {
  if (place.chainOrFranchise) return "CHAIN_OR_FRANCHISE";
  const identity = `${place.name} ${place.brandName}`.toLowerCase().replace(/[\s-]+/g, "_");
  return CHAIN_OR_FRANCHISE_PATTERN.test(identity) ? "CHAIN_OR_FRANCHISE" : "";
}

function overtureBusinessEligibility(place) {
  if (!place.id || !place.name) return { eligible: false, reason: "IDENTITY_MISSING" };
  if (place.country && place.country !== "US") return { eligible: false, reason: "OUTSIDE_US" };
  if (place.operatingStatus && !["OPEN", "OPERATIONAL"].includes(place.operatingStatus)) {
    return { eligible: false, reason: "NOT_OPERATIONAL" };
  }
  if (place.confidence < 0.7) return { eligible: false, reason: "LOW_CONFIDENCE" };
  if (!TARGET_CATEGORY_PATTERN.test(place.category)) return { eligible: false, reason: "CATEGORY_MISMATCH" };
  const chainReason = chainOrFranchiseReason(place);
  if (chainReason) return { eligible: false, reason: chainReason };
  return { eligible: true, reason: "BUSINESS_QUALIFIED" };
}

export function overturePlaceEligibility(place, emailCheck, score, options = {}) {
  const minimumScore = Math.max(1, Number(options.minimumScore) || 70);
  const businessDecision = overtureBusinessEligibility(place);
  if (!businessDecision.eligible) return businessDecision;
  if (!emailCheck.valid) return { eligible: false, reason: emailCheck.reason };
  if (!place.website && !place.phone && !place.socials.length) return { eligible: false, reason: "INSUFFICIENT_BUSINESS_DATA" };
  if (score < minimumScore) return { eligible: false, reason: "LOW_SCORE" };
  return { eligible: true, reason: "PENDING_EXTERNAL_VERIFICATION" };
}

function fieldsForOvertureLead(place, email, emailCheck, score, { runName, now }) {
  return {
    "Intake Status": "pending_external_verification",
    "Email Status": "pending_external_verification",
    "Email Eligible": "no",
    "Video Eligible": "no",
    "Source System": "overture",
    "Source Run Name": runName,
    "Last Seen At": now.toISOString(),
    "Dedup Key": `overture:${place.id}`,
    "Place ID": place.id,
    "Business Name": place.name,
    Category: place.category,
    Description: place.description,
    Address: place.address,
    City: place.city,
    State: place.state,
    "State Code": place.state,
    "Postal Code": place.postalCode,
    Country: "United States",
    "Country Code": "US",
    Website: place.website,
    Email: email,
    Phone: place.phone,
    "About JSON": JSON.stringify({ description: place.description, socials: place.socials }),
    "Social Profiles JSON": JSON.stringify(place.socials),
    "Email Validation Status": "PENDING_EXTERNAL_VERIFICATION",
    "Email Validation Provider": "",
    "Email Validation Checked At": "",
    "Email Validation Details": "Syntax and mail-domain DNS passed; mailbox not externally verified",
    "Email Catch All": "",
    "Email Disposable": emailCheck.disposable ? "yes" : "no",
    "Email Risky": "",
    "Email DNS Check": emailCheck.reason,
    "Email DNS Checked At": now.toISOString(),
    "Email Source URL": "Overture Maps Places",
    "Lead Score": score,
    "Lead Status": "enriched",
    "Lead Status Updated At": now.toISOString(),
    "Lead Decision": "pending_verification",
    "Lead Decision Reason": "PENDING_EXTERNAL_VERIFICATION",
    "Lead Rejection Reason": "",
    "Website Assessment": websiteKind(place.website),
    "Raw Row JSON": JSON.stringify(place.raw)
  };
}

function fieldsForCandidate(place, emailCheck, score, reason, { runName, now }) {
  return {
    "Intake Status": "candidate",
    "Email Status": "enrichment_required",
    "Email Eligible": "no",
    "Video Eligible": "no",
    "Source System": "overture",
    "Source Run Name": runName,
    "Last Seen At": now.toISOString(),
    "Dedup Key": `overture:${place.id}`,
    "Place ID": place.id,
    "Business Name": place.name,
    Category: place.category,
    Description: place.description,
    Address: place.address,
    City: place.city,
    State: place.state,
    "State Code": place.state,
    "Postal Code": place.postalCode,
    Country: "United States",
    "Country Code": "US",
    Website: place.website,
    Email: "",
    Phone: place.phone,
    "About JSON": JSON.stringify({ description: place.description, socials: place.socials }),
    "Social Profiles JSON": JSON.stringify(place.socials),
    "Email Validation Status": "NOT_CHECKED",
    "Email Validation Provider": "",
    "Email Validation Checked At": "",
    "Email Validation Details": reason,
    "Email Catch All": "",
    "Email Disposable": emailCheck.disposable ? "yes" : "no",
    "Email Risky": "",
    "Email DNS Check": emailCheck.reason,
    "Email DNS Checked At": now.toISOString(),
    "Email Source URL": "Overture Maps Places",
    "Lead Score": score,
    "Lead Status": "candidate",
    "Lead Status Updated At": now.toISOString(),
    "Lead Decision": "pending_enrichment",
    "Lead Decision Reason": reason,
    "Lead Rejection Reason": "",
    "Website Assessment": websiteKind(place.website),
    "Raw Row JSON": JSON.stringify(place.raw)
  };
}

function fieldsForRejectedPlace(place, score, reason, { runName, now }) {
  return {
    "Intake Status": "rejected",
    "Source System": "overture",
    "Source Run Name": runName,
    "Last Seen At": now.toISOString(),
    "Dedup Key": `overture:${place.id}`,
    "Place ID": place.id,
    "Business Name": place.name,
    Category: place.category,
    Address: place.address,
    City: place.city,
    State: place.state,
    "State Code": place.state,
    "Postal Code": place.postalCode,
    Country: "United States",
    "Country Code": "US",
    Website: place.website,
    Phone: place.phone,
    "Lead Score": score,
    "Lead Status": "rejected",
    "Lead Status Updated At": now.toISOString(),
    "Lead Decision": "rejected",
    "Lead Decision Reason": reason,
    "Lead Rejection Reason": reason
  };
}

function dedupSets(records) {
  const keys = new Set();
  const emails = new Set();
  for (const record of records || []) {
    const fields = record.fields || {};
    const key = text(fields["Dedup Key"]);
    const email = text(fields.Email).toLowerCase();
    if (key) keys.add(key);
    if (email) emails.add(email);
  }
  return { keys, emails };
}

export async function ingestOverturePlaces(places, dependencies, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const runName = text(options.runName) || `Overture ${now.toISOString().slice(0, 10)}`;
  const existing = options.existingRecords || await dependencies.data.listRecords(
    dependencies.config.airtable.rawOutscraperTableId,
    { fields: ["Dedup Key", "Email"] }
  );
  const { keys, emails } = dedupSets(existing);
  const accepted = [];
  const candidates = [];
  const rejectedRecords = [];
  const rejected = [];

  for (const input of Array.isArray(places) ? places : []) {
    const place = normalizeOverturePlace(input);
    const dedupKey = `overture:${place.id}`;
    if (keys.has(dedupKey)) {
      rejected.push({ id: place.id, name: place.name, reason: "DUPLICATE_PLACE" });
      continue;
    }
    const businessDecision = overtureBusinessEligibility(place);
    if (!businessDecision.eligible) {
      const score = scoreOvertureLead(place);
      rejected.push({ id: place.id, name: place.name, reason: businessDecision.reason, score });
      rejectedRecords.push(fieldsForRejectedPlace(place, score, businessDecision.reason, { runName, now }));
      keys.add(dedupKey);
      continue;
    }
    let selectedEmail = "";
    let emailCheck = { valid: false, reason: "EMAIL_MISSING" };
    let duplicateEmailFound = false;
    for (const email of place.emails) {
      if (emails.has(email)) {
        duplicateEmailFound = true;
        continue;
      }
      const check = await validateEmailLocally(email, options.dns);
      if (check.valid) {
        selectedEmail = email;
        emailCheck = check;
        break;
      }
      emailCheck = check;
    }
    if (!selectedEmail && duplicateEmailFound) emailCheck = { valid: false, reason: "DUPLICATE_EMAIL" };
    const score = scoreOvertureLead(place, emailCheck);
    if (!selectedEmail) {
      const reason = emailCheck.reason || "EMAIL_ENRICHMENT_REQUIRED";
      candidates.push(fieldsForCandidate(place, emailCheck, score, reason, { runName, now }));
      keys.add(dedupKey);
      continue;
    }
    const decision = overturePlaceEligibility(place, emailCheck, score, options);
    if (!decision.eligible) {
      rejected.push({ id: place.id, name: place.name, reason: decision.reason, score });
      rejectedRecords.push(fieldsForRejectedPlace(place, score, decision.reason, { runName, now }));
      keys.add(dedupKey);
      continue;
    }
    accepted.push(fieldsForOvertureLead(place, selectedEmail, emailCheck, score, { runName, now }));
    keys.add(dedupKey);
    emails.add(selectedEmail);
  }

  const created = [];
  const staged = [...accepted, ...candidates, ...rejectedRecords];
  if (!options.dryRun) {
    for (let index = 0; index < staged.length; index += 10) {
      created.push(...await dependencies.data.createRecords(
        dependencies.config.airtable.rawOutscraperTableId,
        staged.slice(index, index + 10),
        { skipConflicts: true }
      ));
    }
  }
  const rejectionCounts = {};
  for (const item of rejected) rejectionCounts[item.reason] = (rejectionCounts[item.reason] || 0) + 1;
  return {
    success: true,
    dryRun: Boolean(options.dryRun),
    inspected: Array.isArray(places) ? places.length : 0,
    accepted: accepted.length,
    candidates: candidates.length,
    rejectedStored: rejectedRecords.length,
    created: options.dryRun ? 0 : created.length,
    pendingExternalVerification: accepted.length,
    rejectionCounts,
    rejected: rejected.slice(0, 50),
    records: options.includeRecords ? staged : undefined
  };
}

function normalizedResultStatus(result) {
  return text(result.status || result.result || result.verdict || result.email_status).toUpperCase().replace(/[ -]+/g, "_");
}

export async function applyExternalVerificationResults(results, dependencies, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const records = options.records || await dependencies.data.listRecords(
    dependencies.config.airtable.rawOutscraperTableId,
    { fields: ["Email", "Source System", "Lead Decision"] }
  );
  const byId = new Map(records.map((record) => [record.id, record]));
  const byEmail = new Map(records.map((record) => [text(record.fields?.Email).toLowerCase(), record]).filter(([email]) => email));
  const approved = new Set(["GOOD", "OK", "VALID", "DELIVERABLE"]);
  const summary = { success: true, inspected: 0, approved: 0, rejected: 0, notFound: 0 };

  for (const result of Array.isArray(results) ? results : []) {
    summary.inspected += 1;
    const record = byId.get(text(result.record_id || result.recordId)) || byEmail.get(text(result.email).toLowerCase());
    if (!record || text(record.fields?.["Source System"]).toLowerCase() !== "overture") {
      summary.notFound += 1;
      continue;
    }
    const status = normalizedResultStatus(result);
    const catchAll = ["CATCH_ALL", "CATCHALL", "ACCEPT_ALL"].includes(status) || result.catch_all === true;
    const disposable = ["DISPOSABLE", "TEMPORARY", "TEMP_EMAIL"].includes(status) || result.disposable === true;
    const risky = ["RISKY", "ROLE", "ROLE_ACCOUNT", "SPAMTRAP"].includes(status) || result.risky === true;
    const isApproved = approved.has(status) && !catchAll && !disposable && !risky;
    const decisionReason = isApproved ? "EXTERNAL_VERIFICATION_GOOD" : (status || "UNKNOWN");
    const fields = {
      "Email Validation Status": status || "UNKNOWN",
      "Email Validation Provider": text(result.provider) || "external_batch",
      "Email Validation Checked At": text(result.checked_at || result.checkedAt) || now.toISOString(),
      "Email Validation Details": text(result.details || result.reason),
      "Email Validation Raw JSON": JSON.stringify(result),
      "Email Catch All": catchAll ? "yes" : "no",
      "Email Disposable": disposable ? "yes" : "no",
      "Email Risky": risky ? "yes" : "no",
      "Email Eligible": isApproved ? "yes" : "no",
      "Email Status": isApproved ? "verified" : "rejected",
      "Lead Status": isApproved ? "approved" : "rejected",
      "Lead Status Updated At": now.toISOString(),
      "Lead Decision": isApproved ? "approved" : "rejected",
      "Lead Decision Reason": decisionReason,
      "Lead Rejection Reason": isApproved ? "" : decisionReason
    };
    if (isApproved) summary.approved += 1;
    else summary.rejected += 1;
    if (options.dryRun) continue;
    await dependencies.data.updateRecordInTable(dependencies.config.airtable.rawOutscraperTableId, record.id, fields);
  }
  return summary;
}

export function pendingVerificationBatch(records, limit = 500) {
  return (records || [])
    .filter((record) => text(record.fields?.["Source System"]).toLowerCase() === "overture")
    .filter((record) => text(record.fields?.["Lead Decision"]).toLowerCase() === "pending_verification")
    .filter((record) => isValidLeadEmail(record.fields?.Email))
    .slice(0, Math.max(1, Math.min(2000, Number(limit) || 500)))
    .map((record) => ({
      record_id: record.id,
      email: text(record.fields.Email).toLowerCase(),
      business_name: text(record.fields["Business Name"]),
      website: text(record.fields.Website)
    }));
}
