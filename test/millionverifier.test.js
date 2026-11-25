import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../server/config.js";
import { verifyPendingEmails } from "../server/millionverifier.js";

const dns = {
  async resolveMx(domain) { return [{ priority: 10, exchange: `mail.${domain}` }]; },
  async resolve4() { return []; },
  async resolve6() { return []; }
};

function lead(overrides = {}) {
  return {
    id: "recLead",
    fields: {
      Email: "owner@example.com",
      "Business Name": "Example Co",
      "Source System": "overture",
      "Lead Status": "enriched",
      "Lead Decision": "pending_verification",
      ...overrides
    }
  };
}

function dependencies(records, verifyEmail) {
  const updates = [];
  return {
    updates,
    value: {
      config,
      data: {
        async listRecords() { return records; },
        async updateRecordInTable(tableId, id, fields) { updates.push({ tableId, id, fields }); }
      },
      millionVerifier: { verifyEmail }
    }
  };
}

test("MillionVerifier approves only an ok result and stores the original response", async () => {
  const raw = { email: "owner@example.com", quality: "good", result: "ok", resultcode: 1, credits: 42, error: "" };
  const context = dependencies([lead()], async () => raw);
  const result = await verifyPendingEmails(context.value, { dns, now: new Date("2026-11-25T08:00:00Z") });

  assert.equal(result.apiCalls, 1);
  assert.equal(result.approved, 1);
  assert.equal(context.updates.length, 1);
  assert.equal(context.updates[0].fields["Email Validation Status"], "OK");
  assert.equal(context.updates[0].fields["Email Validation Provider"], "millionverifier");
  assert.deepEqual(JSON.parse(context.updates[0].fields["Email Validation Raw JSON"]), raw);
  assert.equal(context.updates[0].fields["Lead Decision"], "approved");
});

test("a current good verification is reused without another paid call", async () => {
  let calls = 0;
  const context = dependencies([lead({
    "Email Validation Status": "OK",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-10T08:00:00.000Z",
    "Email Catch All": "no",
    "Email Disposable": "no",
    "Email Risky": "no"
  })], async () => { calls += 1; return {}; });
  const result = await verifyPendingEmails(context.value, { dns, now: new Date("2026-11-25T08:00:00Z") });

  assert.equal(calls, 0);
  assert.equal(result.reused, 1);
  assert.equal(context.updates[0].fields["Lead Decision"], "approved");
  assert.equal(context.updates[0].fields["Lead Decision Reason"], "CURRENT_EXTERNAL_VERIFICATION_REUSED");
});

test("duplicate email is rejected before MillionVerifier is called", async () => {
  let calls = 0;
  const duplicate = { id: "recOther", fields: { Email: "owner@example.com", "Source System": "outscraper" } };
  const context = dependencies([lead(), duplicate], async () => { calls += 1; return {}; });
  const result = await verifyPendingEmails(context.value, { dns });

  assert.equal(calls, 0);
  assert.equal(result.rejected, 1);
  assert.equal(context.updates[0].fields["Lead Decision Reason"], "DUPLICATE_EMAIL");
});

test("timeout keeps the lead pending and records a retryable reason", async () => {
  const context = dependencies([lead()], async () => {
    const error = new Error("timed out");
    error.code = "MILLIONVERIFIER_TIMEOUT";
    throw error;
  });
  const result = await verifyPendingEmails(context.value, { dns });

  assert.equal(result.errors, 1);
  assert.equal(context.updates[0].fields["Lead Decision"], "pending_verification");
  assert.equal(context.updates[0].fields["Email Eligible"], "no");
  assert.equal(context.updates[0].fields["Lead Decision Reason"], "MILLIONVERIFIER_TIMEOUT");
});

test("dry run performs free checks without calling the paid API", async () => {
  let calls = 0;
  const context = dependencies([lead()], async () => { calls += 1; return {}; });
  const result = await verifyPendingEmails(context.value, { dns, dryRun: true });

  assert.equal(calls, 0);
  assert.equal(result.apiCalls, 0);
  assert.equal(result.results[0].outcome, "would_verify");
  assert.equal(context.updates.length, 0);
});
