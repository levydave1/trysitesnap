import { createHmac, timingSafeEqual } from "node:crypto";
import {
  auditExistingBacklog,
  prepareExistingBacklogDrafts,
  verifyExistingBacklog
} from "./backlog-preparation.js";
import { createRuntimeDependencies } from "./runtime.js";
import { planSafeUnsentLeadDedupe } from "./lead-dedupe.js";
import { applyExternalVerificationResults, pendingVerificationBatch } from "./overture-leads.js";

const COOKIE_NAME = "sitesnap_dashboard";
const SESSION_SECONDS = 12 * 60 * 60;

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function safeEqual(left, right) {
  const a = Buffer.from(text(left));
  const b = Buffer.from(text(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function signature(payload, key) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createDashboardSession(key, options = {}) {
  const now = Math.floor(Number(options.now || Date.now()) / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: now + SESSION_SECONDS })).toString("base64url");
  return `${payload}.${signature(payload, key)}`;
}

export function verifyDashboardSession(token, key, options = {}) {
  try {
    const [payload, suppliedSignature, extra] = text(token).split(".");
    if (!payload || !suppliedSignature || extra) return false;
    if (!safeEqual(suppliedSignature, signature(payload, key))) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Math.floor(Number(options.now || Date.now()) / 1000);
    return claims.v === 1 && Number(claims.exp) > now;
  } catch {
    return false;
  }
}

function cookies(request) {
  return Object.fromEntries(text(request.headers?.cookie).split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    try {
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    } catch {
      return ["", ""];
    }
  }).filter(([name]) => name));
}

function dashboardKey() {
  return text(process.env.DASHBOARD_ACCESS_KEY);
}

function authenticated(request, key) {
  return verifyDashboardSession(cookies(request)[COOKIE_NAME], key);
}

function countBy(records, field, fallback = "לא מסווג") {
  const counts = {};
  for (const record of records) {
    const value = text(record.fields?.[field]) || fallback;
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function recent(records, limit) {
  return [...records]
    .sort((a, b) => String(b.createdTime || "").localeCompare(String(a.createdTime || "")))
    .slice(0, limit);
}

function rawLeadSummary(record) {
  const fields = record.fields || {};
  return {
    id: record.id,
    createdTime: record.createdTime,
    businessName: text(fields["Business Name"]),
    email: text(fields.Email),
    website: text(fields.Website),
    category: text(fields.Category),
    city: text(fields.City),
    state: text(fields["State Code"] || fields.State),
    source: text(fields["Source System"]),
    sourceRun: text(fields["Source Run Name"]),
    score: Number(fields["Lead Score"]) || null,
    status: text(fields["Lead Status"]),
    decision: text(fields["Lead Decision"]),
    decisionReason: text(fields["Lead Decision Reason"] || fields["Lead Rejection Reason"]),
    verification: text(fields["Email Validation Status"]),
    emailStatus: text(fields["Email Status"]),
    enrichmentStatus: text(fields["Email Enrichment Status"]),
    emailSourceUrl: text(fields["Email Source URL"]),
    emailSourceType: text(fields["Email Source Type"])
  };
}

function threadSummary(record) {
  const fields = record.fields || {};
  return {
    id: record.id,
    createdTime: record.createdTime,
    businessName: text(fields["Business Name"]),
    email: text(fields["To Email"]),
    subject: text(fields.Subject),
    status: text(fields["Reply Status"]),
    queuedAt: text(fields["Queued At"]),
    sentAt: text(fields["Sent At"])
  };
}

function jobSummary(record) {
  const fields = record.fields || {};
  return {
    id: record.id,
    createdTime: record.createdTime,
    businessName: text(fields["Business Name"]),
    customerEmail: text(fields["Customer Email"]),
    status: text(fields["Generation Status"]),
    draftUrl: text(fields["Draft Site URL"]),
    generatedUrl: text(fields["Generated Site URL"]),
    finalDomain: text(fields["final domain"]),
    notes: text(fields["Error Log"] || fields.Notes).slice(0, 300)
  };
}

function dailyCounts(records, days = 14) {
  const today = new Date();
  const buckets = [];
  const byDate = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    const key = date.toISOString().slice(0, 10);
    const bucket = { date: key, count: 0 };
    buckets.push(bucket);
    byDate.set(key, bucket);
  }
  for (const record of records) {
    const key = text(record.createdTime).slice(0, 10);
    if (byDate.has(key)) byDate.get(key).count += 1;
  }
  return buckets;
}

export async function buildDashboardOverview(data, config) {
  const [tables, rawRecords, threadRecords, generationRecords] = await Promise.all([
    data.listTables(),
    data.listRecords(config.airtable.rawOutscraperTableId, { fields: [
      "Business Name", "Email", "Website", "Category", "City", "State", "State Code",
      "Source System", "Source Run Name", "Lead Score", "Lead Status", "Lead Decision", "Lead Decision Reason", "Lead Rejection Reason",
      "Email Validation Status", "Email Status", "Email Eligible", "Email Enrichment Status", "Email Source URL", "Email Source Type"
    ] }),
    data.listRecords(config.airtable.emailThreadsTableId, { fields: [
      "Business ID", "Business Name", "To Email", "Subject", "Reply Status", "Queued At", "Sent At"
    ] }),
    data.listRecords(config.airtable.tableId, { fields: [
      "Business Name", "Customer Email", "Generation Status", "Draft Site URL",
      "Generated Site URL", "final domain", "Error Log", "Notes"
    ] })
  ]);

  const rawStatus = countBy(rawRecords, "Lead Decision");
  const verification = countBy(rawRecords, "Email Validation Status");
  const threadStatus = countBy(threadRecords, "Reply Status");
  const generationStatus = countBy(generationRecords, "Generation Status");
  const pending = rawRecords.filter((record) => lower(record.fields?.["Lead Decision"]) === "pending_verification").length;
  const candidates = rawRecords.filter((record) => lower(record.fields?.["Lead Status"]) === "candidate").length;
  const emailsFound = rawRecords.filter((record) => lower(record.fields?.["Email Enrichment Status"]) === "found").length;
  const emailsNotFound = rawRecords.filter((record) => lower(record.fields?.["Email Enrichment Status"]) === "not_found").length;
  const approved = rawRecords.filter((record) => lower(record.fields?.["Lead Decision"]) === "approved").length;
  const rejected = rawRecords.filter((record) => lower(record.fields?.["Lead Decision"]) === "rejected").length;
  const queued = threadRecords.filter((record) => ["queued", "sent", "delivered", "replied"].includes(lower(record.fields?.["Reply Status"]))).length;
  const sketches = generationRecords.filter((record) => text(record.fields?.["Draft Site URL"] || record.fields?.["Generated Site URL"])).length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalRecords: tables.reduce((sum, table) => sum + table.recordCount, 0),
      importedFromAirtable: tables.reduce((sum, table) => sum + table.importedCount, 0),
      managedLocally: tables.reduce((sum, table) => sum + table.liveCount, 0),
      leads: rawRecords.length,
      candidates,
      emailsFound,
      emailsNotFound,
      pendingVerification: pending,
      approved,
      rejected,
      queuedInInstantly: queued,
      generationJobs: generationRecords.length,
      sketches
    },
    tables,
    breakdowns: {
      sources: countBy(rawRecords, "Source System"),
      leadDecisions: rawStatus,
      leadStatuses: countBy(rawRecords, "Lead Status"),
      enrichment: countBy(rawRecords, "Email Enrichment Status"),
      verification,
      emailThreads: threadStatus,
      generation: generationStatus
    },
    activity: {
      leadsByDay: dailyCounts(rawRecords),
      emailsByDay: dailyCounts(threadRecords)
    },
    recent: {
      leads: recent(rawRecords, 30).map(rawLeadSummary),
      emailThreads: recent(threadRecords, 20).map(threadSummary),
      generationJobs: recent(generationRecords, 20).map(jobSummary)
    },
    systems: [
      { name: "Neon", status: "active", detail: "מסד הנתונים הראשי" },
      { name: "Airtable", status: "disconnected", detail: "המידע ההיסטורי נמצא ב‑Neon" },
      { name: "Make", status: "partial", detail: "תרחישים שהועברו כבויים; 04 נשמר כגיבוי פעיל" },
      { name: "Outscraper", status: "paused", detail: "איסוף חדש מושהה" },
      { name: "Overture", status: "active", detail: "איסוף יומי, סינון, איתור מייל ציבורי ותיעוד המקור" },
      { name: "Instantly", status: "active", detail: "אימות בתשלום כבוי בייבוא" }
    ],
    workflowUrl: "https://github.com/levydave1/trysitesnap/actions/workflows/overture-leads.yml"
  };
}

function limitedValue(value) {
  if (value === null || value === undefined) return "";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length > 1500 ? `${serialized.slice(0, 1500)}…` : serialized;
}

function safeRecord(record) {
  return {
    id: record.id,
    createdTime: record.createdTime,
    fields: Object.fromEntries(Object.entries(record.fields || {}).map(([key, value]) => [key, limitedValue(value)]))
  };
}

function csvCell(value) {
  let normalized = String(value ?? "");
  if (/^[=+\-@]/.test(normalized)) normalized = `'${normalized}`;
  return /[",\r\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

function verificationCsv(records) {
  const rows = pendingVerificationBatch(records, 2000);
  return [
    "record_id,email,business_name,website",
    ...rows.map((row) => [row.record_id, row.email, row.business_name, row.website].map(csvCell).join(","))
  ].join("\r\n");
}

export async function leadDashboardHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const key = dashboardKey();
  if (!key) return response.status(503).json({ success: false, code: "DASHBOARD_NOT_CONFIGURED" });
  const action = lower(request.body?.action || request.query?.action || "overview");

  if (request.method === "POST" && action === "login") {
    if (!safeEqual(request.body?.password, key)) return response.status(401).json({ success: false, code: "INVALID_LOGIN" });
    const session = createDashboardSession(key);
    response.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
    return response.status(200).json({ success: true });
  }

  if (!authenticated(request, key)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });
  if (request.method === "POST" && request.headers?.["x-sitesnap-dashboard"] !== "1") {
    return response.status(403).json({ success: false, code: "CSRF_CHECK_FAILED" });
  }

  const dependencies = createRuntimeDependencies({ airtable: true });
  const data = dependencies.airtable;
  if (typeof data.listTables !== "function" || typeof data.browseRecords !== "function") {
    return response.status(503).json({ success: false, code: "POSTGRES_DASHBOARD_REQUIRED" });
  }

  try {
    if (request.method === "GET" && action === "overview") {
      return response.status(200).json({ success: true, ...(await buildDashboardOverview(data, dependencies.config)) });
    }
    if (request.method === "GET" && action === "records") {
      const tables = await data.listTables();
      const tableId = text(request.query?.table_id);
      if (!tables.some((table) => table.id === tableId)) return response.status(400).json({ success: false, code: "INVALID_TABLE" });
      const result = await data.browseRecords(tableId, {
        limit: request.query?.limit,
        offset: request.query?.offset,
        search: request.query?.q
      });
      return response.status(200).json({ success: true, ...result, records: result.records.map(safeRecord) });
    }
    if (request.method === "GET" && action === "verification_csv") {
      const records = await data.listRecords(dependencies.config.airtable.rawOutscraperTableId, {
        fields: ["Email", "Business Name", "Website", "Source System", "Lead Decision"]
      });
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="sitesnap-verification-${new Date().toISOString().slice(0, 10)}.csv"`);
      return response.status(200).send(`\uFEFF${verificationCsv(records)}`);
    }
    if (request.method === "GET" && action === "backlog_audit") {
      const result = await auditExistingBacklog({ config: dependencies.config, data });
      return response.status(200).json(result);
    }
    if (request.method === "POST" && action === "backlog_verify") {
      if (request.body?.confirm !== "VERIFY_EXISTING_BACKLOG") {
        return response.status(400).json({ success: false, code: "BACKLOG_VERIFICATION_CONFIRMATION_REQUIRED" });
      }
      const dryRun = request.body?.dry_run === true;
      const runtime = createRuntimeDependencies({ airtable: true, millionVerifier: !dryRun });
      const result = await verifyExistingBacklog({
        config: runtime.config,
        data: runtime.airtable,
        millionVerifier: runtime.millionVerifier
      }, {
        limit: request.body?.limit,
        concurrency: request.body?.concurrency,
        dryRun
      });
      console.log(JSON.stringify({ event: "existing_backlog_verification_completed", ...result, results: undefined }));
      return response.status(200).json(result);
    }
    if (request.method === "POST" && action === "backlog_draft") {
      if (request.body?.confirm !== "PREPARE_EXISTING_BACKLOG_DRAFTS") {
        return response.status(400).json({ success: false, code: "BACKLOG_DRAFT_CONFIRMATION_REQUIRED" });
      }
      const dryRun = request.body?.dry_run === true;
      const runtime = createRuntimeDependencies({ airtable: true, emailDraft: !dryRun });
      const result = await prepareExistingBacklogDrafts({
        config: runtime.config,
        data: runtime.airtable,
        claude: runtime.claude,
        groq: runtime.groq,
        gemini: runtime.gemini
      }, {
        limit: request.body?.limit,
        concurrency: request.body?.concurrency,
        dryRun
      });
      console.log(JSON.stringify({ event: "existing_backlog_drafts_completed", ...result, results: undefined }));
      return response.status(200).json(result);
    }
    if (request.method === "POST" && action === "verification_results") {
      const results = Array.isArray(request.body?.results) ? request.body.results : [];
      if (!results.length || results.length > 2000) return response.status(400).json({ success: false, code: "INVALID_RESULTS" });
      const result = await applyExternalVerificationResults(results, { config: dependencies.config, data });
      return response.status(200).json(result);
    }
    if (request.method === "POST" && action === "dedupe_unsent_leads") {
      const [rawRecords, threadRecords] = await Promise.all([
        data.listRecords(dependencies.config.airtable.rawOutscraperTableId, { fields: [
          "Email", "Place ID", "Business Name", "Website", "Source Run Name",
          "Source System", "Email Status", "Email Eligible"
        ] }),
        data.listRecords(dependencies.config.airtable.emailThreadsTableId, {
          fields: ["Business ID", "To Email"]
        })
      ]);
      const plan = planSafeUnsentLeadDedupe(rawRecords, threadRecords);
      if (request.body?.confirm !== "DELETE_SAFE_DUPLICATES") {
        return response.status(200).json({ success: true, dryRun: true, ...plan, deleteIds: undefined });
      }
      if (typeof data.deleteRecordsFromTable !== "function") {
        return response.status(503).json({ success: false, code: "POSTGRES_DELETE_REQUIRED" });
      }
      const deletedIds = await data.deleteRecordsFromTable(
        dependencies.config.airtable.rawOutscraperTableId,
        plan.deleteIds
      );
      return response.status(200).json({
        success: true,
        dryRun: false,
        scanned: plan.scanned,
        eligibleUnsent: plan.eligibleUnsent,
        duplicateGroups: plan.duplicateGroups,
        planned: plan.deleteIds.length,
        deleted: deletedIds.length,
        kept: plan.keepCount
      });
    }
    if (request.method === "POST" && action === "logout") {
      response.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return response.status(200).json({ success: true });
    }
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  } catch (error) {
    console.error(JSON.stringify({
      event: "lead_dashboard_failed",
      code: error.code || "LEAD_DASHBOARD_FAILED",
      message: text(error.message).slice(0, 300)
    }));
    return response.status(500).json({ success: false, code: error.code || "LEAD_DASHBOARD_FAILED" });
  }
}
