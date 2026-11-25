import assert from "node:assert/strict";
import test from "node:test";
import {
  auditExistingBacklog,
  deterministicBacklogEmail,
  prepareExistingBacklogDrafts,
  verifyExistingBacklog
} from "../server/backlog-preparation.js";
import { config } from "../server/config.js";

const dns = {
  async resolveMx(domain) { return [{ priority: 10, exchange: `mail.${domain}` }]; },
  async resolve4() { return []; },
  async resolve6() { return []; }
};

function raw(id, overrides = {}) {
  return {
    id,
    createdTime: `2026-01-${id.slice(-2).padStart(2, "0")}T00:00:00.000Z`,
    fields: {
      "Source System": "outscraper",
      "Business Name": `Business ${id}`,
      Email: `${id}@example.test`,
      "Email Status": "not_started",
      "Email Eligible": "yes",
      ...overrides
    }
  };
}

function thread(id, email, status = "sent") {
  return { id: `thread-${id}`, fields: { "Business ID": [id], "To Email": email, "Reply Status": status } };
}

test("backlog audit excludes direct website inquiries and already-contacted records", async () => {
  const rawRecords = [
    raw("rec01"),
    raw("rec02", { Email: "" }),
    raw("rec03"),
    raw("rec04", { "Source System": "site" })
  ];
  const result = await auditExistingBacklog({}, {
    rawRecords,
    threadRecords: [thread("rec03", "rec03@example.test")]
  });
  assert.equal(result.directWebsiteExcluded, 1);
  assert.equal(result.untouched, 2);
  assert.equal(result.withEmail, 1);
  assert.equal(result.withoutEmail, 1);
  assert.equal(result.pendingPaidVerification, 1);
});

test("backlog verification checks only unique uncontacted Outscraper leads", async () => {
  const updates = [];
  let calls = 0;
  const rawRecords = [
    raw("rec01", { Email: "owner@acme.test" }),
    raw("rec02", { Email: "contacted@acme.test" }),
    raw("rec03", { Email: "site@acme.test", "Source System": "site" }),
    raw("rec04", { Email: "overture@acme.test", "Source System": "overture", "Lead Decision": "pending_verification" })
  ];
  const result = await verifyExistingBacklog({
    config,
    data: {
      async listRecords(tableId) {
        return tableId === config.airtable.rawOutscraperTableId
          ? rawRecords
          : [thread("rec02", "contacted@acme.test")];
      },
      async updateRecordInTable(tableId, id, fields) { updates.push({ tableId, id, fields }); }
    },
    millionVerifier: {
      async verifyEmail() {
        calls += 1;
        return { email: "owner@acme.test", result: "ok", quality: "good", error: "" };
      }
    }
  }, { dns, now: new Date("2026-11-25T10:00:00.000Z") });
  assert.equal(result.selected, 1);
  assert.equal(result.approved, 1);
  assert.equal(calls, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec01");
  assert.equal(updates[0].fields["Email Validation Provider"], "millionverifier");
});

test("backlog draft preparation stores a draft without initializing or calling Instantly", async () => {
  const created = [];
  const updates = [];
  const approved = raw("rec01", {
    Email: "owner@acme.test",
    "Lead Decision": "approved",
    "Email Eligible": "yes",
    "Email Status": "verified",
    "Email Validation Status": "OK",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-25T09:00:00.000Z",
    "Email Catch All": "no",
    "Email Disposable": "no",
    "Email Risky": "no"
  });
  const result = await prepareExistingBacklogDrafts({
    config,
    data: {
      async listRecords(tableId) { return tableId === config.airtable.rawOutscraperTableId ? [approved] : []; },
      async createRecord(tableId, fields) { created.push({ tableId, fields }); return { id: "recDraft" }; },
      async updateRecordInTable(tableId, id, fields) { updates.push({ tableId, id, fields }); }
    },
    claude: {
      async writeEmail() { return { subject: "Quick question", body: "Would you like to see a tailored homepage concept?" }; }
    }
  }, { now: new Date("2026-11-25T10:00:00.000Z") });
  assert.equal(result.drafted, 1);
  assert.equal(result.errors, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].tableId, config.airtable.emailThreadsTableId);
  assert.equal(created[0].fields[config.airtable.emailThreadFields.status], "draft");
  assert.equal(created[0].fields[config.airtable.emailThreadFields.rawBusinessRecord][0], "rec01");
  assert.equal(created[0].fields["Draft Model Provider"], "claude");
  assert.equal(updates[0].fields["Draft Status"], "prepared");
});

test("backlog draft preparation falls back to Gemini only when Claude credits are exhausted", async () => {
  const created = [];
  const approved = raw("rec01", {
    Email: "owner@acme.test",
    "Lead Decision": "approved",
    "Email Eligible": "yes",
    "Email Status": "verified",
    "Email Validation Status": "OK",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-25T09:00:00.000Z"
  });
  const failure = new Error("claude request failed (400)");
  failure.code = "CLAUDE_UPSTREAM_ERROR";
  failure.upstreamStatus = 400;
  failure.upstreamDetails = "Your credit balance is too low to access the Anthropic API.";
  const result = await prepareExistingBacklogDrafts({
    config,
    data: {
      async listRecords(tableId) { return tableId === config.airtable.rawOutscraperTableId ? [approved] : []; },
      async createRecord(tableId, fields) { created.push({ tableId, fields }); return { id: "recDraft" }; },
      async updateRecordInTable() {}
    },
    claude: { async writeEmail() { throw failure; } },
    gemini: { async analyze() { return { subject: "Homepage idea", body: "Would you like a free, no-obligation homepage concept?" }; } }
  }, { now: new Date("2026-11-25T10:00:00.000Z") });
  assert.equal(result.drafted, 1);
  assert.equal(result.errors, 0);
  assert.equal(created[0].fields["Draft Model Provider"], "gemini");
});

test("backlog draft preparation uses an audited local template when both AI balances are empty", async () => {
  const created = [];
  const approved = raw("rec01", {
    "First Name": "Sam",
    "Business Name": "Acme Roofing",
    Email: "owner@acme.test",
    "Lead Decision": "approved",
    "Email Eligible": "yes",
    "Email Status": "verified",
    "Email Validation Status": "OK",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-25T09:00:00.000Z"
  });
  const claudeFailure = new Error("claude request failed (400)");
  claudeFailure.code = "CLAUDE_UPSTREAM_ERROR";
  claudeFailure.upstreamStatus = 400;
  claudeFailure.upstreamDetails = "Your credit balance is too low to access the Anthropic API.";
  const geminiFailure = new Error("gemini request failed (402)");
  geminiFailure.code = "GEMINI_UPSTREAM_ERROR";
  geminiFailure.upstreamStatus = 402;
  geminiFailure.upstreamDetails = "Your prepayment credits are depleted.";
  const result = await prepareExistingBacklogDrafts({
    config,
    data: {
      async listRecords(tableId) { return tableId === config.airtable.rawOutscraperTableId ? [approved] : []; },
      async createRecord(tableId, fields) { created.push({ tableId, fields }); return { id: "recDraft" }; },
      async updateRecordInTable() {}
    },
    claude: { async writeEmail() { throw claudeFailure; } },
    gemini: { async analyze() { throw geminiFailure; } }
  }, { now: new Date("2026-11-25T10:00:00.000Z") });
  assert.equal(result.drafted, 1);
  assert.equal(result.errors, 0);
  assert.equal(created[0].fields["Draft Model Provider"], "local_template");
  assert.match(created[0].fields[config.airtable.emailThreadFields.body], /Acme Roofing/);
  assert.match(created[0].fields[config.airtable.emailThreadFields.body], /free/i);
  assert.match(created[0].fields[config.airtable.emailThreadFields.body], /no obligation/i);
});

test("local backlog templates remain short, truthful, and permission-based", () => {
  for (let index = 0; index < 12; index += 1) {
    const email = deterministicBacklogEmail({
      recordId: `rec${index}`,
      firstName: index % 2 ? "Sam" : "",
      businessName: "Acme Roofing"
    });
    const subjectWords = email.subject.trim().split(/\s+/).length;
    const bodyWords = email.body.trim().split(/\s+/).length;
    assert.ok(subjectWords >= 2 && subjectWords <= 5);
    assert.ok(bodyWords >= 40 && bodyWords <= 55, `${bodyWords}: ${email.body}`);
    assert.match(email.body, /free/i);
    assert.match(email.body, /no obligation/i);
    assert.match(email.body, /\?$/);
    assert.doesNotMatch(email.body, /already (?:built|made|prepared)|finished website|free website/i);
  }
});

test("existing backlog drafts are idempotent", async () => {
  const approved = raw("rec01", {
    Email: "owner@acme.test",
    "Lead Decision": "approved",
    "Email Eligible": "yes",
    "Email Status": "verified",
    "Email Validation Status": "OK",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-25T09:00:00.000Z"
  });
  const result = await prepareExistingBacklogDrafts({
    config,
    data: {
      async listRecords(tableId) {
        return tableId === config.airtable.rawOutscraperTableId
          ? [approved]
          : [thread("rec01", "owner@acme.test", "draft")];
      }
    }
  }, { dryRun: true, now: new Date("2026-11-25T10:00:00.000Z") });
  assert.equal(result.selected, 0);
});

test("backlog draft errors expose safe upstream diagnostics without creating records", async () => {
  let creates = 0;
  const approved = raw("rec01", {
    Email: "owner@acme.test",
    "Lead Decision": "approved",
    "Email Eligible": "yes",
    "Email Status": "verified",
    "Email Validation Status": "OK",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-25T09:00:00.000Z"
  });
  const failure = new Error("claude request failed (400)");
  failure.code = "CLAUDE_UPSTREAM_ERROR";
  failure.upstreamStatus = 400;
  failure.upstreamDetails = "Invalid structured output schema";
  const result = await prepareExistingBacklogDrafts({
    config,
    data: {
      async listRecords(tableId) { return tableId === config.airtable.rawOutscraperTableId ? [approved] : []; },
      async createRecord() { creates += 1; }
    },
    claude: { async writeEmail() { throw failure; } }
  }, { now: new Date("2026-11-25T10:00:00.000Z") });
  assert.equal(result.drafted, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.results[0].upstreamStatus, 400);
  assert.equal(result.results[0].details, "Invalid structured output schema");
  assert.equal(creates, 0);
});

test("a backlog cooldown with no eligible records does not fall back to immediate retries", async () => {
  let calls = 0;
  const coolingDown = raw("rec01", {
    Email: "owner@acme.test",
    "Lead Decision": "pending_verification",
    "Email Status": "pending_external_verification",
    "Email Verification Last Attempt At": "2026-11-25T09:30:00.000Z"
  });
  const result = await verifyExistingBacklog({
    config,
    data: {
      async listRecords(tableId) { return tableId === config.airtable.rawOutscraperTableId ? [coolingDown] : []; },
      async updateRecordInTable() { throw new Error("must not update"); }
    },
    millionVerifier: { async verifyEmail() { calls += 1; return {}; } }
  }, { dns, now: new Date("2026-11-25T10:00:00.000Z") });
  assert.equal(result.backlogRemainingBeforeRun, 0);
  assert.equal(result.selected, 0);
  assert.equal(calls, 0);
});
