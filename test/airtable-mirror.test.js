import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createMirroredAirtableClient,
  createNeonMirrorClient,
  recordChecksum
} from "../server/airtable-mirror.js";
import { reconcileAirtable } from "../server/airtable-reconciliation.js";
import { contentMacMatches } from "../api/airtable-webhook.js";
import { createAirtableClient } from "../server/clients.js";
import { config } from "../server/config.js";

test("create is sent to Airtable first and documented after success", async () => {
  const order = [];
  const events = [];
  const airtable = {
    async createRecord(tableId, fields) {
      order.push("airtable");
      return { id: "rec-created", fields: { ...fields, Status: "Created" } };
    }
  };
  const mirror = {
    async record(event) {
      order.push("mirror");
      events.push(event);
    }
  };
  const client = createMirroredAirtableClient({ airtable, mirror, defaultTableId: "tbl-jobs" });

  const result = await client.createRecord("tbl-raw", { Name: "Test" });

  assert.equal(result.id, "rec-created");
  assert.deepEqual(order, ["airtable", "mirror"]);
  assert.equal(events[0].operation, "create");
  assert.equal(events[0].tableId, "tbl-raw");
  assert.equal(events[0].recordId, "rec-created");
  assert.deepEqual(events[0].fields, { Name: "Test", Status: "Created" });
});

test("update is documented without changing Airtable read methods", async () => {
  const events = [];
  const airtable = {
    async getRecord(id) { return { id }; },
    async updateRecord(id, fields) { return { id, fields }; }
  };
  const client = createMirroredAirtableClient({
    airtable,
    mirror: { async record(event) { events.push(event); } },
    defaultTableId: "tbl-jobs"
  });

  assert.deepEqual(await client.getRecord("rec-1"), { id: "rec-1" });
  await client.updateRecord("rec-1", { Status: "Done" });

  assert.equal(events[0].operation, "update");
  assert.equal(events[0].tableId, "tbl-jobs");
  assert.deepEqual(events[0].fields, { Status: "Done" });
});

test("mirror failure is fail-open after Airtable succeeds", async () => {
  const errors = [];
  const airtable = {
    async updateRecord(id, fields) { return { id, fields }; }
  };
  const client = createMirroredAirtableClient({
    airtable,
    mirror: { async record() { throw new Error("offline"); } },
    defaultTableId: "tbl-jobs",
    logger: { error(message) { errors.push(message); } }
  });

  const result = await client.updateRecord("rec-1", { Status: "Done" });

  assert.equal(result.id, "rec-1");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /airtable_mirror_failed/);
});

test("Airtable failure prevents a false mirror event", async () => {
  let mirrorCalls = 0;
  const client = createMirroredAirtableClient({
    airtable: { async createRecord() { throw new Error("airtable rejected"); } },
    mirror: { async record() { mirrorCalls += 1; } },
    defaultTableId: "tbl-jobs"
  });

  await assert.rejects(() => client.createRecord("tbl-raw", {}), /airtable rejected/);
  assert.equal(mirrorCalls, 0);
});

test("Neon mirror initializes its schema and stores an event plus current record", async () => {
  const transactions = [];
  const sql = (strings, ...values) => ({ strings: [...strings], values });
  sql.transaction = async (queries) => {
    transactions.push(queries);
    return queries.map(() => []);
  };
  const mirror = createNeonMirrorClient({
    databaseUrl: "postgresql://example.invalid/sitesnap",
    neonImpl: () => sql
  });

  await mirror.record({
    eventId: "00000000-0000-4000-8000-000000000001",
    occurredAt: "2026-07-19T09:00:00.000Z",
    source: "airtable",
    operation: "create",
    tableId: "tbl-raw",
    recordId: "rec-1",
    fields: { Name: "Test" }
  });

  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].length, 5);
  assert.match(transactions[0][0].strings.join(""), /CREATE TABLE IF NOT EXISTS airtable_mirror_records/);
  assert.equal(transactions[1].length, 2);
  assert.match(transactions[1][0].strings.join(""), /INSERT INTO airtable_mirror_events/);
  assert.match(transactions[1][1].strings.join(""), /ON CONFLICT \(table_id, record_id\) DO UPDATE/);
  assert.ok(transactions[1][0].values.includes('{"Name":"Test"}'));
});

test("checksums are stable when Airtable field order changes", () => {
  assert.equal(
    recordChecksum({ b: 2, a: { y: 2, x: 1 } }),
    recordChecksum({ a: { x: 1, y: 2 }, b: 2 })
  );
});

test("attachment URL rotation does not create a false Airtable change", () => {
  const first = [{
    id: "att-1",
    filename: "photo.jpg",
    type: "image/jpeg",
    size: 123,
    url: "https://v5.airtableusercontent.com/temporary-one",
    thumbnails: { small: { url: "https://v5.airtableusercontent.com/thumb-one", width: 36, height: 36 } }
  }];
  const second = [{
    id: "att-1",
    filename: "photo.jpg",
    type: "image/jpeg",
    size: 123,
    url: "https://v5.airtableusercontent.com/temporary-two",
    thumbnails: { small: { url: "https://v5.airtableusercontent.com/thumb-two", width: 36, height: 36 } }
  }];

  assert.equal(recordChecksum({ Photos: first }), recordChecksum({ Photos: second }));
});

test("reconciliation reads every configured Airtable table with field IDs", async () => {
  const calls = [];
  const tables = [
    { name: "Businesses", id: "tbl-businesses" },
    { name: "Jobs", id: "tbl-jobs" }
  ];
  const airtable = {
    async listRecords(tableId, options) {
      calls.push({ tableId, options });
      return [{ id: `rec-${tableId}`, fields: { Name: tableId } }];
    }
  };
  const mirror = {
    async reconcileSnapshot(input) { return input; }
  };

  const result = await reconcileAirtable({ airtable, mirror, tables, dryRun: true });

  assert.deepEqual(calls, [
    { tableId: "tbl-businesses", options: { returnFieldsByFieldId: true } },
    { tableId: "tbl-jobs", options: { returnFieldsByFieldId: true } }
  ]);
  assert.equal(result.dryRun, true);
  assert.equal(result.tables[1].records[0].id, "rec-tbl-jobs");
});

test("dry-run reconciliation reports created, changed, unchanged, and missing records", async () => {
  const oldChecksum = recordChecksum({ Name: "Old" });
  const sameChecksum = recordChecksum({ Name: "Same" });
  const sql = (strings, ...values) => {
    const query = strings.join("");
    if (/SELECT record_id/.test(query)) {
      return Promise.resolve([
        { record_id: "rec-changed", checksum: oldChecksum, present_in_airtable: true },
        { record_id: "rec-same", checksum: sameChecksum, present_in_airtable: true },
        { record_id: "rec-missing", checksum: oldChecksum, present_in_airtable: true }
      ]);
    }
    return { strings: [...strings], values };
  };
  sql.transaction = async (queries) => queries.map(() => []);
  const mirror = createNeonMirrorClient({
    databaseUrl: "postgresql://example.invalid/sitesnap",
    neonImpl: () => sql
  });

  const result = await mirror.reconcileSnapshot({
    dryRun: true,
    tables: [{
      name: "Jobs",
      id: "tbl-jobs",
      records: [
        { id: "rec-created", fields: { Name: "New" } },
        { id: "rec-changed", fields: { Name: "Changed" } },
        { id: "rec-same", fields: { Name: "Same" } }
      ]
    }]
  });

  assert.deepEqual(result.totals, {
    airtable: 3,
    mirrorBefore: 3,
    created: 1,
    changed: 1,
    unchanged: 1,
    missing: 1
  });
});

test("reconciliation refuses to run without the durable database", async () => {
  await assert.rejects(
    () => reconcileAirtable({ airtable: {}, mirror: null, tables: [] }),
    (error) => error.code === "MIRROR_DATABASE_NOT_CONFIGURED" && error.status === 503
  );
});

test("Airtable webhook content MAC is verified against the untouched body", () => {
  const secret = Buffer.from("webhook-secret").toString("base64");
  const body = Buffer.from('{"base":{"id":"app-test"}}');
  const valid = `hmac-sha256=${createHmac("sha256", Buffer.from(secret, "base64"))
    .update(body)
    .digest("hex")}`;

  assert.equal(contentMacMatches(body, valid, secret), true);
  assert.equal(contentMacMatches(Buffer.from("changed"), valid, secret), false);
});

test("all five Airtable tables are included in the operational mirror", () => {
  assert.deepEqual(config.airtable.mirrorTables, [
    { name: "Businesses", id: "tblwQtNvfoFA8mRoK" },
    { name: "Generation Jobs", id: "tbl3pEHQ9gMSDs489" },
    { name: "Email Threads", id: "tblGP20OTbsYT8KEC" },
    { name: "Orders Domains", id: "tbl6JynIPTqIfhWc1" },
    { name: "Raw outscraper", id: "tblF7fN1VCF7JWlvA" }
  ]);
});

test("Airtable webhook refresh uses the base-scoped refresh endpoint", async () => {
  const calls = [];
  const client = createAirtableClient({
    baseId: "app-test",
    tableId: "tbl-test",
    accessToken: "secret",
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ expirationTime: "2026-07-26T00:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  await client.refreshWebhook("ach-test");

  assert.equal(calls[0].url, "https://api.airtable.com/v0/bases/app-test/webhooks/ach-test/refresh");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
});
