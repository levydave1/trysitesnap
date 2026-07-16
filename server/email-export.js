import { legacyClaudePrompt, legacyGeminiPrompt, modernClaudePrompt } from "./email-prompts.js";

const rawFieldNames = [
  "First Name",
  "Last Name",
  "Full Name",
  "Business Name",
  "Website Generator",
  "About JSON",
  "Reviews Count",
  "Rating",
  "Website Description",
  "Category",
  "City",
  "Website",
  "Email"
];

function clean(value) {
  return String(value ?? "").trim();
}

export function isValidLeadEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s@/?#]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email);
}

export function leadFromEmailRecord(record) {
  const fields = record.fields || {};
  const firstName = clean(fields["First Name"]);
  const lastName = clean(fields["Last Name"]);
  return {
    recordId: record.id,
    firstName,
    lastName,
    fullName: clean(fields["Full Name"]) || [firstName, lastName].filter(Boolean).join(" "),
    businessName: clean(fields["Business Name"]),
    websiteGenerator: clean(fields["Website Generator"]),
    aboutJson: fields["About JSON"] ?? "",
    reviewsCount: fields["Reviews Count"] ?? "",
    rating: fields.Rating ?? "",
    websiteDescription: clean(fields["Website Description"]),
    category: clean(fields.Category),
    city: clean(fields.City),
    website: clean(fields.Website),
    email: clean(fields.Email).toLowerCase()
  };
}

export function normalizeEmailFlow(value) {
  return String(value || "").trim().toLowerCase() === "legacy" ? "legacy" : "v2";
}

function analysisFromGemini(output) {
  return {
    hook: clean(output?.hook),
    reputation: clean(output?.reputation ?? output?.reputation_comment),
    pain: clean(output?.pain ?? output?.platform_pain)
  };
}

function emailFromClaude(output) {
  const subject = clean(output?.subject);
  const body = clean(output?.body);
  if (!subject || !body) throw new Error("Claude did not return subject and body");
  return { subject, body };
}

export async function generateEmailForLead(dependencies, lead, flow = "v2") {
  const selectedFlow = normalizeEmailFlow(flow);
  if (selectedFlow === "legacy") {
    if (!dependencies.gemini) throw new Error("Gemini is required for the legacy email flow");
    const analysis = analysisFromGemini(await dependencies.gemini.analyze(legacyGeminiPrompt(lead)));
    return emailFromClaude(await dependencies.claude.writeEmail(legacyClaudePrompt(lead, analysis)));
  }
  return emailFromClaude(await dependencies.claude.writeEmail(modernClaudePrompt(lead)));
}

function linkedIds(value) {
  if (Array.isArray(value)) return value.map(clean).filter((item) => item.startsWith("rec"));
  const normalized = clean(value);
  return normalized.startsWith("rec") ? [normalized] : [];
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function ensureInstantlyLead(instantly, payload, email, campaign) {
  try {
    const created = await instantly.createLead(payload);
    if (created?.id) return created;
  } catch (error) {
    if (![400, 409].includes(error.upstreamStatus)) throw error;
  }
  const existing = await instantly.listLeads({ search: email, campaign });
  const lead = (existing.items || []).find((item) => clean(item.email).toLowerCase() === email);
  if (!lead?.id) throw new Error("Instantly did not return a lead ID");
  return lead;
}

function summaryMessage(results) {
  const exported = results.filter((item) => item.status === "exported");
  const failed = results.filter((item) => item.status === "failed");
  const names = exported.slice(0, 15).map((item) => `- ${item.businessName}`).join("\n");
  const omitted = exported.length > 15 ? `\n- ועוד ${exported.length - 15}` : "";
  return `נטענו לידים ל-Instantly\nנשלחו: ${exported.length}\nנכשלו: ${failed.length}${names ? `\n${names}${omitted}` : ""}`;
}

export async function processEmailExportBatch(dependencies, options = {}) {
  const { airtable, gemini, claude, instantly, telegram, config } = dependencies;
  const threadFields = config.airtable.emailThreadFields;
  const maxRecords = Math.max(1, Math.min(
    config.emailExport.maxRecords,
    Number(options.maxRecords) || config.emailExport.maxRecords
  ));

  const threads = await airtable.listRecords(config.airtable.emailThreadsTableId, {
    fields: [threadFields.rawBusinessRecord, threadFields.status],
    returnFieldsByFieldId: true
  });
  const completed = new Set();
  let rawLinkUsesArray = true;
  for (const thread of threads) {
    const value = thread.fields?.[threadFields.rawBusinessRecord];
    if (value !== undefined) rawLinkUsesArray = Array.isArray(value);
    if (clean(thread.fields?.[threadFields.status]).toLowerCase() === "sent") {
      for (const id of linkedIds(value)) completed.add(id);
    }
  }

  const rawRecords = options.recordId
    ? [await airtable.getRecordFromTable(config.airtable.rawOutscraperTableId, options.recordId)]
    : await airtable.listRecords(config.airtable.rawOutscraperTableId, { fields: rawFieldNames });
  const candidates = rawRecords
    .filter((record) => record?.id && !completed.has(record.id))
    .sort((a, b) => String(a.createdTime || "").localeCompare(String(b.createdTime || "")))
    .filter((record) => isValidLeadEmail(leadFromEmailRecord(record).email))
    .slice(0, maxRecords);

  const results = await mapConcurrent(candidates, options.concurrency || config.emailExport.concurrency, async (record) => {
    const lead = leadFromEmailRecord(record);
    try {
      const email = await generateEmailForLead({ gemini, claude }, lead, options.flow);
      const instantLead = await ensureInstantlyLead(instantly, {
        campaign: config.emailExport.campaignId,
        email: lead.email,
        website: lead.website || null,
        last_name: lead.lastName || null,
        first_name: lead.firstName || null,
        company_name: lead.businessName || null,
        custom_variables: {
          city: lead.city,
          subject: email.subject,
          emailBody: email.body,
          businessId: record.id,
          airtableRecordId: record.id,
          websiteGenerator: lead.websiteGenerator
        },
        skip_if_in_workspace: true,
        skip_if_in_campaign: true,
        verify_leads_on_import: true
      }, lead.email, config.emailExport.campaignId);

      if (!completed.has(record.id)) {
        await airtable.createRecord(config.airtable.emailThreadsTableId, {
          [threadFields.subject]: email.subject,
          [threadFields.body]: email.body,
          [threadFields.direction]: "outgoing",
          [threadFields.contactName]: lead.fullName,
          [threadFields.sender]: config.emailExport.senderLabel,
          [threadFields.rawBusinessRecord]: rawLinkUsesArray ? [record.id] : record.id,
          [threadFields.sentAt]: new Date().toISOString(),
          [threadFields.instantlyLeadId]: instantLead.id,
          [threadFields.businessName]: lead.businessName,
          [threadFields.recipientEmail]: lead.email,
          [threadFields.status]: "sent",
          [threadFields.searchText]: `${email.body}${email.subject}`
        });
        completed.add(record.id);
      }
      return {
        status: "exported",
        recordId: record.id,
        instantlyLeadId: instantLead.id,
        businessName: lead.businessName,
        subject: email.subject
      };
    } catch (error) {
      return {
        status: "failed",
        recordId: record.id,
        businessName: lead.businessName,
        code: error.code || "EMAIL_EXPORT_FAILED",
        message: clean(error.message).slice(0, 240)
      };
    }
  });

  if (options.notify !== false && results.length) {
    await telegram?.send(summaryMessage(results)).catch(() => undefined);
  }
  return {
    success: true,
    flow: normalizeEmailFlow(options.flow),
    candidates: candidates.length,
    exported: results.filter((item) => item.status === "exported").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
    results
  };
}

export function isLocalNoon(date, timeZone = "Asia/Jerusalem") {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23"
  }).format(date) === "12";
}
