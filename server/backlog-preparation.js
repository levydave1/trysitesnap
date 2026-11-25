import { generateEmailForLead, leadFromEmailRecord } from "./email-export.js";
import { verifyPendingEmails } from "./millionverifier.js";

const CONTACTED_STATUSES = new Set(["queued", "sent", "delivered", "replied"]);
const APPROVED_VERIFICATION = new Set(["GOOD", "OK"]);
const DRAFT_VERSION = "v2-backlog-2026-11-25";

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function truthy(value) {
  return ["1", "true", "yes", "y"].includes(lower(value));
}

function linkedIds(value) {
  if (Array.isArray(value)) return value.map(text).filter((item) => item.startsWith("rec"));
  const serialized = text(value);
  if (serialized.startsWith("[")) {
    try {
      const parsed = JSON.parse(serialized);
      return Array.isArray(parsed) ? parsed.map(text).filter((item) => item.startsWith("rec")) : [];
    } catch {
      return [];
    }
  }
  return serialized.startsWith("rec") ? [serialized] : [];
}

function threadIndex(threadRecords) {
  const contactedIds = new Set();
  const contactedEmails = new Set();
  const draftIds = new Set();
  const draftEmails = new Set();
  for (const record of threadRecords || []) {
    const fields = record.fields || {};
    const status = lower(fields["Reply Status"]);
    const ids = linkedIds(fields["Business ID"]);
    const email = lower(fields["To Email"]);
    if (status === "draft") {
      ids.forEach((id) => draftIds.add(id));
      if (email) draftEmails.add(email);
      continue;
    }
    if (!status || CONTACTED_STATUSES.has(status)) {
      ids.forEach((id) => contactedIds.add(id));
      if (email) contactedEmails.add(email);
    }
  }
  return { contactedIds, contactedEmails, draftIds, draftEmails };
}

function wasContacted(record, index) {
  const email = lower(record.fields?.Email);
  return index.contactedIds.has(record.id) || (email && index.contactedEmails.has(email));
}

function isOutscraper(record) {
  return lower(record.fields?.["Source System"]) === "outscraper";
}

function recentRetry(fields, now, cooldownHours = 24) {
  if (lower(fields["Lead Decision"]) !== "pending_verification") return false;
  const attemptedAt = Date.parse(text(fields["Email Verification Last Attempt At"]));
  return Number.isFinite(attemptedAt) && now.getTime() - attemptedAt < cooldownHours * 3_600_000;
}

function verificationCandidates(rawRecords, threadRecords, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const index = threadIndex(threadRecords);
  return (rawRecords || []).filter((record) => {
    const fields = record.fields || {};
    if (!isOutscraper(record) || wasContacted(record, index) || !lower(fields.Email)) return false;
    if (["approved", "rejected"].includes(lower(fields["Lead Decision"]))) return false;
    if (["verified", "rejected"].includes(lower(fields["Email Status"]))) return false;
    return !recentRetry(fields, now);
  }).sort((left, right) => String(left.createdTime || "").localeCompare(String(right.createdTime || "")) || left.id.localeCompare(right.id));
}

function safeCurrentVerification(fields, now, maxAgeDays) {
  const status = text(fields["Email Validation Status"]).toUpperCase();
  const checkedAt = Date.parse(text(fields["Email Validation Checked At"]));
  if (!APPROVED_VERIFICATION.has(status) || !text(fields["Email Validation Provider"]) || !Number.isFinite(checkedAt)) return false;
  if (now.getTime() - checkedAt < 0 || now.getTime() - checkedAt > maxAgeDays * 86_400_000) return false;
  return !truthy(fields["Email Catch All"]) && !truthy(fields["Email Disposable"]) && !truthy(fields["Email Risky"]);
}

function draftCandidates(rawRecords, threadRecords, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxAgeDays = Math.max(1, Number(options.maxAgeDays) || 30);
  const index = threadIndex(threadRecords);
  return (rawRecords || []).filter((record) => {
    const fields = record.fields || {};
    const email = lower(fields.Email);
    if (!isOutscraper(record) || wasContacted(record, index) || !email) return false;
    if (index.draftIds.has(record.id) || index.draftEmails.has(email)) return false;
    if (lower(fields["Lead Decision"]) !== "approved" || lower(fields["Email Eligible"]) !== "yes") return false;
    return safeCurrentVerification(fields, now, maxAgeDays);
  }).sort((left, right) => String(left.createdTime || "").localeCompare(String(right.createdTime || "")) || left.id.localeCompare(right.id));
}

async function loadRecords(dependencies) {
  const rawTableId = dependencies.config.airtable.rawOutscraperTableId;
  const threadTableId = dependencies.config.airtable.emailThreadsTableId;
  const [rawRecords, threadRecords] = await Promise.all([
    dependencies.data.listRecords(rawTableId),
    dependencies.data.listRecords(threadTableId, { fields: [
      "Business ID", "To Email", "Reply Status", "Subject", "Email Body",
      "Draft Source", "Draft Model Provider"
    ] })
  ]);
  return { rawRecords, threadRecords, rawTableId, threadTableId };
}

function duplicateEmailSummary(records) {
  const counts = new Map();
  for (const record of records) {
    const email = lower(record.fields?.Email);
    if (email) counts.set(email, (counts.get(email) || 0) + 1);
  }
  const groups = [...counts.values()].filter((count) => count > 1);
  return { groups: groups.length, rows: groups.reduce((sum, count) => sum + count, 0) };
}

export async function auditExistingBacklog(dependencies, options = {}) {
  const { rawRecords, threadRecords } = options.rawRecords && options.threadRecords
    ? options
    : await loadRecords(dependencies);
  const index = threadIndex(threadRecords);
  const outscraper = rawRecords.filter(isOutscraper);
  const untouched = outscraper.filter((record) => !wasContacted(record, index));
  const withEmail = untouched.filter((record) => lower(record.fields?.Email));
  const withoutEmail = untouched.filter((record) => !lower(record.fields?.Email));
  const duplicateEmails = duplicateEmailSummary(withEmail);
  const verification = verificationCandidates(rawRecords, threadRecords, options);
  const drafts = draftCandidates(rawRecords, threadRecords, options);
  return {
    success: true,
    scanned: rawRecords.length,
    outscraper: outscraper.length,
    directWebsiteExcluded: rawRecords.filter((record) => lower(record.fields?.["Source System"]) === "site").length,
    untouched: untouched.length,
    withEmail: withEmail.length,
    withoutEmail: withoutEmail.length,
    duplicateEmailGroups: duplicateEmails.groups,
    duplicateEmailRows: duplicateEmails.rows,
    pendingPaidVerification: verification.length,
    readyForDraft: drafts.length,
    existingDrafts: index.draftIds.size
  };
}

export async function verifyExistingBacklog(dependencies, options = {}) {
  const loaded = options.rawRecords && options.threadRecords ? options : await loadRecords(dependencies);
  const candidates = verificationCandidates(loaded.rawRecords, loaded.threadRecords, options);
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
  const selected = candidates.slice(0, limit);
  const result = await verifyPendingEmails(dependencies, {
    records: loaded.rawRecords,
    sourceSystem: "outscraper",
    eligibleRecordIds: new Set(selected.map((record) => record.id)),
    limit,
    concurrency: options.concurrency,
    dryRun: options.dryRun,
    dns: options.dns,
    now: options.now
  });
  return { ...result, backlogRemainingBeforeRun: candidates.length };
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
  return results;
}

function claudeCreditExhausted(error) {
  return error?.code === "CLAUDE_UPSTREAM_ERROR"
    && error?.upstreamStatus === 400
    && /credit balance is too low/i.test(text(error?.upstreamDetails || error?.message));
}

function geminiCreditExhausted(error) {
  return error?.code === "GEMINI_UPSTREAM_ERROR"
    && [400, 402].includes(error?.upstreamStatus)
    && /(prepayment credits are depleted|credit balance is too low|billing)/i.test(text(error?.upstreamDetails || error?.message));
}

function firstNameOrBlank(lead) {
  const name = text(lead.firstName || lead.fullName).split(/\s+/)[0];
  return name && !/@|https?:|www\./i.test(name) ? name : "";
}

function templateIndex(seed, count) {
  let hash = 0;
  for (const character of text(seed)) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % count;
}

export function deterministicBacklogEmail(lead) {
  const firstName = firstNameOrBlank(lead);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const business = text(lead.businessName) || "your business";
  const businessReference = business.split(/\s+/).length > 6 ? "your business" : business;
  const variants = [
    {
      subject: "A homepage idea",
      body: `${greeting} I can put together a homepage concept for ${businessReference} using public information, focused on making the main services easier to understand. Preparing and viewing the concept is free, with no obligation. It is simply a way to see a possible direction. Would you like me to prepare it?`
    },
    {
      subject: "Quick website idea",
      body: `${greeting} I would be happy to prepare a homepage concept tailored to ${businessReference} from public information. The focus would be giving potential customers a clearer next step. Preparing and viewing the concept is free, and there is no obligation. Would you like me to put it together?`
    },
    {
      subject: "A clearer homepage",
      body: `${greeting} I can create a simple homepage concept for ${businessReference} based on public information, with a stronger first impression for potential customers. Preparing and viewing the concept is free, and there is no obligation. It is just a chance to see the idea before deciding anything. Should I prepare it?`
    },
    {
      subject: "Homepage concept",
      body: `${greeting} I can prepare a tailored homepage concept for ${businessReference} using public information. I would keep it focused on presenting the services clearly for first-time visitors. Preparing and viewing the concept is free, with no obligation attached. Would you like me to create it for you?`
    }
  ];
  return variants[templateIndex(lead.recordId || lead.email || business, variants.length)];
}

async function generateBacklogEmail(dependencies, lead) {
  try {
    return {
      ...(await generateEmailForLead({ claude: dependencies.claude }, lead, "v2")),
      provider: "claude"
    };
  } catch (error) {
    if (!claudeCreditExhausted(error) || !dependencies.gemini) throw error;
    const geminiWriter = { writeEmail: (prompt) => dependencies.gemini.analyze(prompt) };
    try {
      return {
        ...(await generateEmailForLead({ claude: geminiWriter }, lead, "v2")),
        provider: "gemini"
      };
    } catch (fallbackError) {
      if (!geminiCreditExhausted(fallbackError)) throw fallbackError;
      return { ...deterministicBacklogEmail(lead), provider: "local_template" };
    }
  }
}

export async function prepareExistingBacklogDrafts(dependencies, options = {}) {
  const loaded = options.rawRecords && options.threadRecords ? options : await loadRecords(dependencies);
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const candidates = draftCandidates(loaded.rawRecords, loaded.threadRecords, options).slice(0, limit);
  const summary = {
    success: true,
    dryRun: Boolean(options.dryRun),
    selected: candidates.length,
    drafted: 0,
    errors: 0,
    results: []
  };
  if (options.dryRun) return summary;
  const threadFields = dependencies.config.airtable.emailThreadFields;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const results = await mapConcurrent(candidates, Math.max(1, Math.min(5, Number(options.concurrency) || 3)), async (record) => {
    const lead = leadFromEmailRecord(record);
    try {
      const email = await generateBacklogEmail(dependencies, lead);
      const draft = await dependencies.data.createRecord(loaded.threadTableId, {
        [threadFields.subject]: email.subject,
        [threadFields.body]: email.body,
        [threadFields.direction]: "outgoing",
        [threadFields.contactName]: lead.fullName,
        [threadFields.sender]: dependencies.config.emailExport.senderLabel,
        [threadFields.rawBusinessRecord]: [record.id],
        "Drafted At": now.toISOString(),
        "Draft Prompt Version": DRAFT_VERSION,
        "Draft Source": "existing_backlog",
        "Draft Model Provider": email.provider,
        [threadFields.businessName]: lead.businessName,
        [threadFields.recipientEmail]: lead.email,
        [threadFields.status]: "draft",
        [threadFields.searchText]: `${email.body}${email.subject}`
      });
      await dependencies.data.updateRecordInTable(loaded.rawTableId, record.id, {
        "Draft Status": "prepared",
        "Draft Email Thread ID": draft.id,
        "Draft Prepared At": now.toISOString(),
        "Draft Prompt Version": DRAFT_VERSION
      });
      return { recordId: record.id, businessName: lead.businessName, outcome: "drafted" };
    } catch (error) {
      return {
        recordId: record.id,
        businessName: lead.businessName,
        outcome: "error",
        code: error.code || "DRAFT_FAILED",
        upstreamStatus: error.upstreamStatus || null,
        details: text(error.upstreamDetails || error.message).slice(0, 300)
      };
    }
  });
  for (const result of results) {
    if (result.outcome === "drafted") summary.drafted += 1;
    else summary.errors += 1;
    summary.results.push(result);
  }
  return summary;
}

export async function refreshLocalBacklogDrafts(dependencies, options = {}) {
  const loaded = options.rawRecords && options.threadRecords ? options : await loadRecords(dependencies);
  const rawById = new Map(loaded.rawRecords.map((record) => [record.id, record]));
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 1000));
  const candidates = loaded.threadRecords.filter((record) => {
    const fields = record.fields || {};
    return lower(fields["Reply Status"]) === "draft"
      && lower(fields["Draft Source"]) === "existing_backlog"
      && lower(fields["Draft Model Provider"]) === "local_template";
  }).slice(0, limit);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const threadFields = dependencies.config.airtable.emailThreadFields;
  let refreshed = 0;
  let skipped = 0;
  for (const draft of candidates) {
    const sourceId = linkedIds(draft.fields?.["Business ID"])[0];
    const rawRecord = rawById.get(sourceId);
    if (!rawRecord) {
      skipped += 1;
      continue;
    }
    const email = deterministicBacklogEmail(leadFromEmailRecord(rawRecord));
    if (!options.dryRun) {
      await dependencies.data.updateRecordInTable(loaded.threadTableId, draft.id, {
        [threadFields.subject]: email.subject,
        [threadFields.body]: email.body,
        [threadFields.searchText]: `${email.body}${email.subject}`,
        "Draft Refreshed At": now.toISOString()
      });
    }
    refreshed += 1;
  }
  return { success: true, dryRun: Boolean(options.dryRun), selected: candidates.length, refreshed, skipped };
}

export const backlogDraftVersion = DRAFT_VERSION;
