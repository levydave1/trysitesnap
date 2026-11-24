import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../server/config.js";
import { emailExportEligibility } from "../server/lead-eligibility.js";
import {
  applyExternalVerificationResults,
  ingestOverturePlaces,
  normalizeOverturePlace,
  pendingVerificationBatch,
  validateEmailLocally
} from "../server/overture-leads.js";

const samplePlace = {
  id: "overture-place-1",
  names: { primary: "Reliable Roof & Gutter" },
  taxonomy: { primary: "roofing_contractor" },
  confidence: 0.96,
  operating_status: "open",
  addresses: [{ freeform: "15 Main St", locality: "Austin", region: "TX", postcode: "78701", country: "US" }],
  websites: ["https://reliableroof.example"],
  emails: ["hello@reliableroof.example"],
  phones: ["+15125550100"],
  socials: ["https://facebook.com/reliableroof"]
};

const dns = {
  async resolveMx(domain) { return [{ priority: 10, exchange: `mail.${domain}` }]; },
  async resolve4() { return []; },
  async resolve6() { return []; }
};

test("Overture normalization preserves the business facts needed for scoring", () => {
  const lead = normalizeOverturePlace(samplePlace);
  assert.equal(lead.name, "Reliable Roof & Gutter");
  assert.equal(lead.category, "roofing_contractor");
  assert.equal(lead.city, "Austin");
  assert.equal(lead.country, "US");
  assert.equal(lead.emails[0], "hello@reliableroof.example");
});

test("free email checks require syntax and working mail DNS but do not claim mailbox verification", async () => {
  assert.deepEqual(await validateEmailLocally("bad-address", dns), { valid: false, reason: "INVALID_SYNTAX" });
  const valid = await validateEmailLocally("hello@reliableroof.example", dns);
  assert.equal(valid.valid, true);
  assert.equal(valid.reason, "MX_FOUND");
});

test("Overture ingestion stores qualified leads as pending and never as sendable", async () => {
  const writes = [];
  const result = await ingestOverturePlaces([samplePlace], {
    config,
    data: {
      async listRecords() { return []; },
      async createRecords(tableId, records) { writes.push({ tableId, records }); return records.map((_, index) => ({ id: `rec${index}` })); }
    }
  }, { dns, now: new Date("2026-11-24T08:00:00Z"), includeRecords: true });

  assert.equal(result.accepted, 1);
  assert.equal(result.created, 1);
  assert.equal(writes[0].tableId, config.airtable.rawOutscraperTableId);
  const fields = writes[0].records[0];
  assert.equal(fields["Source System"], "overture");
  assert.equal(fields["Email Validation Status"], "PENDING_EXTERNAL_VERIFICATION");
  assert.equal(fields["Email Eligible"], "no");
  assert.equal(fields["Lead Decision"], "pending_verification");
});

test("duplicate place and email are rejected before Neon writes", async () => {
  let writes = 0;
  const result = await ingestOverturePlaces([samplePlace], {
    config,
    data: {
      async listRecords() { return [{ id: "recOld", fields: { "Dedup Key": "overture:overture-place-1", Email: "other@example.com" } }]; },
      async createRecords() { writes += 1; return []; }
    }
  }, { dns });
  assert.equal(result.accepted, 0);
  assert.equal(result.rejectionCounts.DUPLICATE_PLACE, 1);
  assert.equal(writes, 0);
});

test("external result import approves only good non-catch-all mailboxes", async () => {
  const updates = [];
  const records = [
    { id: "recGood", fields: { Email: "good@example.com", "Source System": "overture", "Lead Decision": "pending_verification" } },
    { id: "recCatchAll", fields: { Email: "catch@example.com", "Source System": "overture", "Lead Decision": "pending_verification" } }
  ];
  const result = await applyExternalVerificationResults([
    { email: "good@example.com", status: "good", provider: "batch-test" },
    { email: "catch@example.com", status: "catch-all", provider: "batch-test" }
  ], {
    config,
    data: {
      async listRecords() { return records; },
      async updateRecordInTable(tableId, id, fields) { updates.push({ tableId, id, fields }); }
    }
  }, { now: new Date("2026-11-24T09:00:00Z") });

  assert.equal(result.approved, 1);
  assert.equal(result.rejected, 1);
  assert.equal(updates[0].fields["Lead Decision"], "approved");
  assert.equal(updates[1].fields["Lead Decision"], "rejected");
  assert.equal(emailExportEligibility({ fields: { ...records[0].fields, ...updates[0].fields } }, { now: new Date("2026-11-25T09:00:00Z") }).eligible, true);
  assert.equal(emailExportEligibility({ fields: { ...records[1].fields, ...updates[1].fields } }, { now: new Date("2026-11-25T09:00:00Z") }).eligible, false);
});

test("verification batch exports only pending Overture leads", () => {
  const batch = pendingVerificationBatch([
    { id: "recPending", fields: { Email: "pending@example.com", "Business Name": "Pending Co", "Source System": "overture", "Lead Decision": "pending_verification" } },
    { id: "recApproved", fields: { Email: "approved@example.com", "Source System": "overture", "Lead Decision": "approved" } },
    { id: "recLegacy", fields: { Email: "legacy@example.com", "Source System": "outscraper" } }
  ]);
  assert.deepEqual(batch, [{ record_id: "recPending", email: "pending@example.com", business_name: "Pending Co", website: "" }]);
});
