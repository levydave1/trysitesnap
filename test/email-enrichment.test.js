import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichOvertureEmails,
  extractStructuredEmails,
  extractVisibleEmails,
  fetchPublicPage,
  resetFoundEnrichment,
  reusableExternalVerification,
  selectEnrichmentCandidates
} from "../server/email-enrichment.js";

const config = { airtable: { rawOutscraperTableId: "raw" } };
const dns = {
  async resolveMx() { return [{ priority: 10, exchange: "mail.example.net" }]; },
  async resolve4() { return []; },
  async resolve6() { return []; }
};
const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];

function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html", ...headers } });
}

function candidate(overrides = {}) {
  return {
    id: overrides.id || "recCandidate",
    createdTime: "2026-11-24T00:00:00.000Z",
    fields: {
      "Source System": "overture",
      "Lead Status": "candidate",
      "Lead Decision": "pending_enrichment",
      "Business Name": "Acme Roofing",
      Website: "https://acme.test/",
      Email: "",
      "Social Profiles JSON": "[]",
      "About JSON": "{}",
      "Raw Row JSON": "{}",
      ...overrides.fields
    }
  };
}

test("email extraction finds mailto, visible, obfuscated, and JSON-LD addresses", () => {
  const html = `
    <a href="mailto:hello@acme.test?subject=Hi">Email us</a>
    <p>Sales: sales [at] acme [dot] test</p>
    <p>Find information at example dot com and discover the destination.</p>
    <script>const hidden = "ignored@script.test"</script>
    <script type="application/ld+json">{"@type":"Organization","contactPoint":{"email":"office@acme.test"}}</script>`;
  assert.deepEqual(extractVisibleEmails(html).sort(), ["hello@acme.test", "sales@acme.test"]);
  assert.deepEqual(extractStructuredEmails(html), ["office@acme.test"]);
});

test("public page fetching blocks local and private network destinations", async () => {
  let fetched = false;
  await assert.rejects(fetchPublicPage("http://localhost/internal", {
    fetchImpl: async () => { fetched = true; return htmlResponse("secret"); }
  }), /UNSAFE_HOST/);
  await assert.rejects(fetchPublicPage("https://business.test/", {
    resolveHost: async () => [{ address: "192.168.1.5", family: 4 }],
    fetchImpl: async () => { fetched = true; return htmlResponse("secret"); }
  }), /UNSAFE_HOST/);
  assert.equal(fetched, false);
});

test("candidate selection observes success, not-found, and error cooldowns", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  const records = [
    candidate({ id: "fresh" }),
    candidate({ id: "notFound", fields: { "Email Enrichment Status": "not_found", "Email Enrichment Checked At": "2026-11-20T00:00:00.000Z" } }),
    candidate({ id: "oldNotFound", fields: { "Email Enrichment Status": "not_found", "Email Enrichment Checked At": "2026-10-01T00:00:00.000Z" } }),
    candidate({ id: "recentError", fields: { "Email Enrichment Status": "error", "Email Enrichment Checked At": "2026-11-25T08:00:00.000Z" } })
  ];
  assert.deepEqual(selectEnrichmentCandidates(records, { now }).map((record) => record.id), ["fresh", "oldNotFound"]);
});

test("stage 4 follows official site to contact page and stores documented evidence without making the lead sendable", async () => {
  const updates = [];
  const fetchImpl = async (url) => {
    if (url === "https://acme.test/") return htmlResponse('<a href="/contact-us">Contact</a>');
    if (url === "https://acme.test/contact-us") return htmlResponse('<p>Email <a href="mailto:hello@acme.test">hello@acme.test</a></p>');
    return htmlResponse("missing", 404);
  };
  const result = await enrichOvertureEmails({
    config,
    data: {
      async listRecords() { return [candidate()]; },
      async updateRecordInTable(tableId, id, fields) { updates.push({ tableId, id, fields }); }
    }
  }, { fetchImpl, resolveHost, dns, now: new Date("2026-11-25T12:00:00.000Z") });

  assert.equal(result.found, 1);
  assert.equal(result.updated, 1);
  assert.equal(updates[0].fields.Email, "hello@acme.test");
  assert.equal(updates[0].fields["Email Source URL"], "https://acme.test/contact-us");
  assert.equal(updates[0].fields["Email Source Type"], "contact_or_about");
  assert.equal(updates[0].fields["Email Eligible"], "no");
  assert.equal(updates[0].fields["Lead Decision"], "pending_verification");
  assert.equal(updates[0].fields["Email Validation Status"], "PENDING_EXTERNAL_VERIFICATION");
  const evidence = JSON.parse(updates[0].fields["Email Enrichment Evidence JSON"]);
  assert.equal(evidence.tried[0].type, "official_site");
  assert.equal(evidence.candidates.at(-1).outcome, "selected");
});

test("stage 4 skips a duplicate address and can select another public address", async () => {
  const updates = [];
  const records = [
    candidate(),
    { id: "recExisting", fields: { "Source System": "outscraper", Email: "used@acme.test" } }
  ];
  const fetchImpl = async (url) => url === "https://acme.test/"
    ? htmlResponse("<h1>Acme Roofing</h1><p>used@acme.test or new@acme.test</p>")
    : htmlResponse("missing", 404);
  const result = await enrichOvertureEmails({
    config,
    data: {
      async listRecords() { return records; },
      async updateRecordInTable(tableId, id, fields) { updates.push(fields); }
    }
  }, { fetchImpl, resolveHost, dns });
  assert.equal(result.found, 1);
  assert.equal(updates[0].Email, "new@acme.test");
  assert.match(updates[0]["Email Enrichment Evidence JSON"], /"outcome":"duplicate"/);
});

test("stage 4 rejects a real address that belongs to somebody else on a generic corporate page", async () => {
  const updates = [];
  const record = candidate({
    fields: {
      "Business Name": "Matt Steves of Serhant Naples",
      Website: "https://serhant.test/"
    }
  });
  const fetchImpl = async (url) => url === "https://serhant.test/"
    ? htmlResponse("<h1>Serhant</h1><p>Naples listings by <a href='mailto:coyne@serhant.test'>Coyne</a></p>")
    : htmlResponse("missing", 404);
  const result = await enrichOvertureEmails({
    config,
    data: {
      async listRecords() { return [record]; },
      async updateRecordInTable(tableId, id, fields) { updates.push(fields); }
    }
  }, { fetchImpl, resolveHost, dns });
  assert.equal(result.found, 0);
  assert.equal(result.notFound, 1);
  assert.equal(updates[0].Email, undefined);
  assert.match(updates[0]["Email Enrichment Evidence JSON"], /not_business_linked/);
});

test("stage 4 records a completed no-email search and does not write in dry-run mode", async () => {
  let writes = 0;
  const fetchImpl = async () => htmlResponse("<p>Call us today</p>");
  const result = await enrichOvertureEmails({
    config,
    data: {
      async listRecords() { return [candidate()]; },
      async updateRecordInTable() { writes += 1; }
    }
  }, { fetchImpl, resolveHost, dns, dryRun: true });
  assert.equal(result.notFound, 1);
  assert.equal(result.updated, 0);
  assert.equal(writes, 0);
  assert.equal(result.results[0].status, "not_found");
});

test("current external verification is reusable only for the same safe email", () => {
  const fields = {
    Email: "hello@acme.test",
    "Email Validation Status": "good",
    "Email Validation Provider": "millionverifier",
    "Email Validation Checked At": "2026-11-20T00:00:00.000Z",
    "Email Catch All": "no",
    "Email Disposable": "no",
    "Email Risky": "no"
  };
  assert.equal(reusableExternalVerification(fields, "hello@acme.test", { now: new Date("2026-11-25T00:00:00.000Z") }).provider, "millionverifier");
  assert.equal(reusableExternalVerification(fields, "other@acme.test", { now: new Date("2026-11-25T00:00:00.000Z") }), null);
  assert.equal(reusableExternalVerification({ ...fields, "Email Catch All": "yes" }, "hello@acme.test", { now: new Date("2026-11-25T00:00:00.000Z") }), null);
});

test("found stage-4 records can be safely reopened while preserving the previous audit evidence", async () => {
  const updates = [];
  const records = [
    candidate({ id: "recFound", fields: {
      Email: "wrong@acme.test",
      "Email Source URL": "https://acme.test/",
      "Email Source Type": "official_site",
      "Email Enrichment Status": "found",
      "Email Enrichment Evidence JSON": "{\"version\":1}"
    } }),
    candidate({ id: "recPending" })
  ];
  const result = await resetFoundEnrichment({
    config,
    data: {
      async listRecords() { return records; },
      async updateRecordInTable(tableId, id, fields) { updates.push({ id, fields }); }
    }
  }, { now: new Date("2026-11-25T13:00:00.000Z") });
  assert.deepEqual({ selected: result.selected, updated: result.updated }, { selected: 1, updated: 1 });
  assert.equal(updates[0].id, "recFound");
  assert.equal(updates[0].fields.Email, "");
  assert.equal(updates[0].fields["Lead Decision"], "pending_enrichment");
  assert.match(updates[0].fields["Email Enrichment Previous Evidence JSON"], /wrong@acme\.test/);
});
