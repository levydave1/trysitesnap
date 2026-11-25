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

test("Overture normalization creates a stable dedupe identity when the source ID is absent", () => {
  const withoutId = { ...samplePlace };
  delete withoutId.id;
  const first = normalizeOverturePlace(withoutId);
  const second = normalizeOverturePlace({ ...withoutId });
  assert.match(first.id, /^dedupe-[a-f0-9]{24}$/);
  assert.equal(first.id, second.id);
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
      async createRecords(tableId, records, options) { writes.push({ tableId, records, options }); return records.map((_, index) => ({ id: `rec${index}` })); }
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
  assert.equal(fields["Lead Status"], "enriched");
  assert.equal(fields["Lead Decision Reason"], "PENDING_EXTERNAL_VERIFICATION");
  assert.deepEqual(JSON.parse(fields["Social Profiles JSON"]), ["https://facebook.com/reliableroof"]);
  assert.equal(writes[0].options.skipConflicts, true);
});

test("businesses without email are retained as candidates for later enrichment", async () => {
  const writes = [];
  const result = await ingestOverturePlaces([{ ...samplePlace, emails: [] }], {
    config,
    data: {
      async listRecords() { return []; },
      async createRecords(tableId, records) { writes.push(...records); return records.map((_, index) => ({ id: `rec${index}` })); }
    }
  }, { dns, now: new Date("2026-11-24T08:00:00Z") });

  assert.equal(result.accepted, 0);
  assert.equal(result.candidates, 1);
  assert.equal(result.created, 1);
  assert.equal(writes[0]["Lead Status"], "candidate");
  assert.equal(writes[0]["Lead Decision"], "pending_enrichment");
  assert.equal(writes[0]["Lead Decision Reason"], "EMAIL_MISSING");
});

test("rejected businesses retain the basic business fields and rejection audit", async () => {
  const writes = [];
  const result = await ingestOverturePlaces([{ ...samplePlace, operating_status: "closed" }], {
    config,
    data: {
      async listRecords() { return []; },
      async createRecords(tableId, records) { writes.push(...records); return records.map((_, index) => ({ id: `rec${index}` })); }
    }
  }, { dns, now: new Date("2026-11-24T08:00:00Z") });

  assert.equal(result.rejectedStored, 1);
  assert.equal(result.rejectionCounts.NOT_OPERATIONAL, 1);
  assert.equal(writes[0].Address, "15 Main St");
  assert.equal(writes[0].City, "Austin");
  assert.equal(writes[0]["State Code"], "TX");
  assert.equal(writes[0].Phone, "+15125550100");
  assert.equal(writes[0].Website, "https://reliableroof.example/");
  assert.equal(writes[0]["Lead Status"], "rejected");
  assert.equal(writes[0]["Lead Rejection Reason"], "NOT_OPERATIONAL");
});

test("ingestion processes every qualified business beyond a target of 50", async () => {
  const writes = [];
  const places = Array.from({ length: 75 }, (_, index) => ({
    ...samplePlace,
    id: `overture-place-${index}`,
    names: { primary: `Reliable Roof ${index}` },
    emails: []
  }));
  const result = await ingestOverturePlaces(places, {
    config,
    data: {
      async listRecords() { return []; },
      async createRecords(tableId, records) { writes.push(...records); return records.map((_, index) => ({ id: `rec${index}` })); }
    }
  }, { dns, now: new Date("2026-11-24T08:00:00Z") });

  assert.equal(result.inspected, 75);
  assert.equal(result.candidates, 75);
  assert.equal(result.created, 75);
  assert.equal(writes.length, 75);
});

test("known chains and franchises are rejected before enrichment", async () => {
  const writes = [];
  const result = await ingestOverturePlaces([{ ...samplePlace, names: { primary: "Roto-Rooter Austin" } }], {
    config,
    data: {
      async listRecords() { return []; },
      async createRecords(tableId, records) { writes.push(...records); return records.map((_, index) => ({ id: `rec${index}` })); }
    }
  }, { dns });
  assert.equal(result.rejectionCounts.CHAIN_OR_FRANCHISE, 1);
  assert.equal(writes[0]["Lead Rejection Reason"], "CHAIN_OR_FRANCHISE");
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
  assert.equal(updates[0].fields["Lead Status"], "approved");
  assert.equal(updates[1].fields["Email Catch All"], "yes");
  assert.equal(JSON.parse(updates[0].fields["Email Validation Raw JSON"]).provider, "batch-test");
  assert.equal(emailExportEligibility({ fields: { ...records[0].fields, ...updates[0].fields } }, { now: new Date("2026-11-25T09:00:00Z") }).eligible, true);
  assert.equal(emailExportEligibility({ fields: { ...records[1].fields, ...updates[1].fields } }, { now: new Date("2026-11-25T09:00:00Z") }).eligible, false);
});

test("risky and disposable verification results remain rejected", async () => {
  const updates = [];
  const records = [
    { id: "recRisky", fields: { Email: "risky@example.com", "Source System": "overture" } },
    { id: "recDisposable", fields: { Email: "temp@example.com", "Source System": "overture" } }
  ];
  const result = await applyExternalVerificationResults([
    { email: "risky@example.com", status: "good", risky: true, provider: "millionverifier" },
    { email: "temp@example.com", status: "disposable", provider: "millionverifier" }
  ], {
    config,
    data: {
      async listRecords() { return records; },
      async updateRecordInTable(tableId, id, fields) { updates.push({ id, fields }); }
    }
  });
  assert.equal(result.approved, 0);
  assert.equal(result.rejected, 2);
  assert.equal(updates[0].fields["Email Risky"], "yes");
  assert.equal(updates[1].fields["Email Disposable"], "yes");
});

test("Instantly gate rejects a risky flag even when other approval fields look valid", () => {
  const result = emailExportEligibility({ fields: {
    "Source System": "overture",
    "Lead Decision": "approved",
    "Email Eligible": "yes",
    "Email Validation Status": "OK",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-24T09:00:00.000Z",
    "Email Catch All": "no",
    "Email Disposable": "no",
    "Email Risky": "yes"
  } }, { now: new Date("2026-11-25T09:00:00Z") });
  assert.deepEqual(result, { eligible: false, reason: "RISKY_NOT_ALLOWED" });
});

test("verification batch exports only pending Overture leads", () => {
  const batch = pendingVerificationBatch([
    { id: "recPending", fields: { Email: "pending@example.com", "Business Name": "Pending Co", "Source System": "overture", "Lead Decision": "pending_verification" } },
    { id: "recApproved", fields: { Email: "approved@example.com", "Source System": "overture", "Lead Decision": "approved" } },
    { id: "recLegacy", fields: { Email: "legacy@example.com", "Source System": "outscraper" } }
  ]);
  assert.deepEqual(batch, [{ record_id: "recPending", email: "pending@example.com", business_name: "Pending Co", website: "" }]);
});
