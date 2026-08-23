import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { config } from "../server/config.js";
import {
  airtableFieldsForLead,
  processOutscraperWebhook,
  selectLeadRows,
  verifyOutscraperWebhook
} from "../server/outscraper-webhook.js";

function lead(overrides = {}) {
  return {
    name: "Daily Test Roofing",
    website: "https://daily-test.example",
    email: "owner@daily-test.example",
    cid: "123456",
    business_status: "OPERATIONAL",
    "email.emails_validator.status": "RECEIVING",
    reviews_per_score: { 5: 12 },
    ...overrides
  };
}

test("Outscraper webhook signatures use the untouched request body", () => {
  const raw = Buffer.from(JSON.stringify({ id: "request-1", status: "SUCCESS" }));
  const key = "outscraper-test-key";
  const signature = createHmac("sha256", key).update(raw).digest("hex");
  assert.equal(verifyOutscraperWebhook(raw, `sha256=${signature}`, key).id, "request-1");
  assert.throws(() => verifyOutscraperWebhook(Buffer.from(`${raw} `), `sha256=${signature}`, key), /Invalid Outscraper signature/);
});

test("lead selection keeps only operational, website, receiving-email businesses and removes duplicates", () => {
  const payload = { data: [[
    lead(),
    lead({ email: "second@daily-test.example" }),
    lead({ cid: "999", email: "old@example.com" }),
    lead({ cid: "998", email: "invalid@example.com", "email.emails_validator.status": "INVALID" }),
    lead({ cid: "997", email: "closed@example.com", business_status: "CLOSED_PERMANENTLY" }),
    lead({ cid: "996", email: "new@example.com", name: "New Business" })
  ]] };
  const result = selectLeadRows(payload, [{ fields: { Email: "old@example.com", CID: "321" } }], 120);
  assert.equal(result.discovered, 6);
  assert.deepEqual(result.selected.map((row) => row.email), ["owner@daily-test.example", "new@example.com"]);
});

test("Airtable mapping preserves the fields used by scenarios 02 and 04", () => {
  const fields = airtableFieldsForLead(lead({
    category: "Roofing contractor",
    phone: "+1 555 0100",
    address: "1 Main St, Austin, TX",
    logo: "https://daily-test.example/logo.png",
    website_generator: "WordPress",
    reviews: 42,
    rating: 4.8
  }), { runName: "Outscraper daily request-1", now: new Date("2026-08-23T08:00:00Z") });
  assert.equal(fields["Business Name"], "Daily Test Roofing");
  assert.equal(fields.Category, "Roofing contractor");
  assert.equal(fields.Email, "owner@daily-test.example");
  assert.equal(fields["Email Eligible"], "yes");
  assert.equal(fields["Website Generator"], "WordPress");
  assert.equal(fields["Reviews Count"], 42);
  assert.equal(fields["Dedup Key"], "123456");
  assert.equal(fields["Source System"], "outscraper");
});

test("Airtable mapping keeps numeric flags and preserves incompatible verified data in raw JSON", () => {
  const fields = airtableFieldsForLead(lead({
    verified: true,
    area_service: false,
    website_has_gtm: 1,
    website_has_fb_pixel: 0,
    "company_insights.is_public": 1
  }));

  assert.equal("Verified" in fields, false);
  assert.equal(fields["Area Service"], false);
  assert.equal(fields["Website Has GTM"], 1);
  assert.equal(fields["Website Has FB Pixel"], 0);
  assert.equal(fields["Is Public Company"], 1);
  assert.equal(JSON.parse(fields["Raw Row JSON"]).verified, true);
});

test("completed Outscraper request imports in Airtable batches and reports the count", async () => {
  const batches = [];
  const rows = Array.from({ length: 13 }, (_, index) => lead({
    name: `Business ${index}`,
    cid: `cid-${index}`,
    email: `owner${index}@example.com`
  }));
  const result = await processOutscraperWebhook({
    id: "request-batch",
    status: "SUCCESS",
    results_location: "https://api.outscraper.cloud/requests/request-batch"
  }, {
    config,
    outscraper: { async getRequestResults() { return { data: rows }; } },
    airtable: {
      async listRecords() { return []; },
      async createRecords(tableId, fields) {
        assert.equal(tableId, config.airtable.rawOutscraperTableId);
        batches.push(fields);
        return fields.map((_, index) => ({ id: `rec-${batches.length}-${index}` }));
      }
    },
    telegram: null
  }, { maxLeads: 120, now: new Date("2026-08-23T08:00:00Z") });
  assert.deepEqual(batches.map((batch) => batch.length), [10, 3]);
  assert.equal(result.created, 13);
  assert.equal(result.belowTarget, true);
});
