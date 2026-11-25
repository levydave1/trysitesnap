import assert from "node:assert/strict";
import test from "node:test";
import { airtableFieldNamesByTable, config } from "../server/config.js";
import { createPostgresDataClient } from "../server/data-store.js";

function fakeDatabase() {
  const records = [
    {
      id: "recAAAAAAAAAAAAAA",
      table_id: config.airtable.tableId,
      created_at: "2026-10-02T00:00:00.000Z",
      fields: { "Business Name": "Later", "Business ID": "recBBBBBBBBBBBBBB", "Draft Site URL": "", Notes: "" }
    },
    {
      id: "recCCCCCCCCCCCCCC",
      table_id: config.airtable.tableId,
      created_at: "2026-10-01T00:00:00.000Z",
      fields: { "Business Name": "Earlier", "Business ID": "recDDDDDDDDDDDDDD", "Draft Site URL": "", Notes: "" }
    },
    {
      id: "recEEEEEEEEEEEEEE",
      table_id: config.airtable.emailThreadsTableId,
      created_at: "2026-10-03T00:00:00.000Z",
      fields: { "Business ID": "recRawRawRawRaw01", "To Email": "owner@example.com", "Reply Status": "sent" }
    }
  ];
  const calls = [];
  async function query(text, values) {
    calls.push({ text, values });
    if (/^SELECT COUNT\(\*\)::bigint AS record_count FROM sitesnap_records/m.test(text)) {
      return [{ record_count: String(records.length) }];
    }
    if (/^SELECT id, fields, created_at FROM sitesnap_records WHERE id=/m.test(text)) {
      return records.filter((record) => record.id === values[0] && record.table_id === values[1]);
    }
    if (/FROM sitesnap_records\s+WHERE table_id=\$1/m.test(text)) {
      const names = values[1] ? JSON.parse(values[1]) : null;
      return records.filter((record) => record.table_id === values[0]).map((record) => ({
        ...record,
        fields: names
          ? Object.fromEntries(Object.entries(record.fields).filter(([name]) => names.includes(name)))
          : record.fields
      }));
    }
    if (/^UPDATE sitesnap_records/m.test(text)) {
      const record = records.find((item) => item.id === values[0] && item.table_id === values[1]);
      if (!record) return [];
      Object.assign(record.fields, JSON.parse(values[2]));
      return [record];
    }
    if (/^INSERT INTO sitesnap_records/m.test(text)) {
      const created = [];
      for (let index = 0; index < values.length; index += 4) {
        const record = {
          id: values[index], table_id: values[index + 1],
          fields: JSON.parse(values[index + 2]), created_at: values[index + 3]
        };
        records.push(record);
        created.push(record);
      }
      return created;
    }
    throw new Error(`Unexpected query: ${text}`);
  }
  return { calls, query, records };
}

function client(database) {
  return createPostgresDataClient({
    defaultTableId: config.airtable.tableId,
    fieldNamesByTable: airtableFieldNamesByTable,
    queryImpl: database.query
  });
}

test("Postgres data store preserves Airtable field-ID reads", async () => {
  const database = fakeDatabase();
  const store = client(database);
  const records = await store.listRecords(config.airtable.emailThreadsTableId, {
    fields: [
      config.airtable.emailThreadFields.rawBusinessRecord,
      config.airtable.emailThreadFields.recipientEmail,
      config.airtable.emailThreadFields.status
    ],
    returnFieldsByFieldId: true
  });
  assert.deepEqual(records[0].fields, {
    [config.airtable.emailThreadFields.rawBusinessRecord]: "recRawRawRawRaw01",
    [config.airtable.emailThreadFields.recipientEmail]: "owner@example.com",
    [config.airtable.emailThreadFields.status]: "sent"
  });
  assert.match(database.calls[0].text, /jsonb_each/);
});

test("Postgres data store translates Airtable field IDs on writes", async () => {
  const database = fakeDatabase();
  const store = client(database);
  const result = await store.updateRecord("recAAAAAAAAAAAAAA", {
    [config.airtable.fields.notes]: "migrated"
  });
  assert.equal(result.fields.Notes, "migrated");
  assert.deepEqual(JSON.parse(database.calls[0].values[2]), { Notes: "migrated" });
  await assert.rejects(
    store.updateRecord("recAAAAAAAAAAAAAA", { fldUnknownField000: "bad" }),
    /Unknown Airtable field ID/
  );
});

test("Postgres data store can update a non-default table", async () => {
  const database = fakeDatabase();
  const store = client(database);
  const result = await store.updateRecordInTable(config.airtable.emailThreadsTableId, "recEEEEEEEEEEEEEE", {
    "Reply Status": "queued"
  });
  assert.equal(result.fields["Reply Status"], "queued");
  assert.equal(database.calls[0].values[1], config.airtable.emailThreadsTableId);
});

test("Postgres data store supports the first-sketch queue filter and ordering", async () => {
  const database = fakeDatabase();
  const store = client(database);
  const records = await store.listRecords(config.airtable.tableId, {
    filterByFormula: "AND({Business Name}!=\"\",{Draft Site URL}=\"\",IS_AFTER(CREATED_TIME(),'2026-09-30T00:00:00.000Z'))",
    maxRecords: 20,
    sort: [{ field: "Created At", direction: "asc" }]
  });
  assert.deepEqual(records.map((record) => record.id), ["recCCCCCCCCCCCCCC", "recAAAAAAAAAAAAAA"]);
  await assert.rejects(
    store.listRecords(config.airtable.tableId, { filterByFormula: "TRUE()" }),
    /Unsupported data-store filter formula/
  );
});

test("Postgres data store creates Airtable-compatible record IDs", async () => {
  const database = fakeDatabase();
  const store = client(database);
  const created = await store.createRecord(config.airtable.rawOutscraperTableId, {
    [config.airtable.rawOutscraperFields.businessName]: "New business"
  });
  assert.match(created.id, /^rec[a-zA-Z0-9]{14}$/);
  assert.equal(created.fields["Business Name"], "New business");
});

test("Postgres data store can ignore identity conflicts for idempotent ingestion", async () => {
  const database = fakeDatabase();
  const store = client(database);
  await store.createRecords(config.airtable.rawOutscraperTableId, [{ "Place ID": "overture-1" }], {
    skipConflicts: true
  });
  assert.match(database.calls[0].text, /ON CONFLICT DO NOTHING/);
});

test("Postgres data store health check reaches the records table", async () => {
  const database = fakeDatabase();
  const store = client(database);
  assert.deepEqual(await store.healthCheck(), { reachable: true });
  assert.match(database.calls[0].text, /COUNT\(\*\).*sitesnap_records/);
});

test("Postgres data store exposes live table counts and paginated record browsing", async () => {
  const calls = [];
  const store = createPostgresDataClient({
    defaultTableId: config.airtable.tableId,
    fieldNamesByTable: airtableFieldNamesByTable,
    queryImpl: async (text, values) => {
      calls.push({ text, values });
      if (/FROM sitesnap_tables t/.test(text)) return [{
        id: "tblHistory", name: "Businesses", record_count: "38", imported_count: "38",
        live_count: "0", field_count: 12, source_exported_at: "2026-11-20T00:00:00Z",
        last_record_update: "2026-11-20T00:00:00Z"
      }];
      if (/SELECT COUNT\(\*\)::bigint AS total/.test(text)) return [{ total: "1" }];
      if (/ORDER BY created_at DESC/.test(text)) return [{
        id: "recDashboardRecord", fields: { "Business Name": "Dashboard Co" }, created_at: "2026-11-24T00:00:00Z"
      }];
      throw new Error(`Unexpected query: ${text}`);
    }
  });
  const tables = await store.listTables();
  assert.deepEqual(tables[0], {
    id: "tblHistory", name: "Businesses", recordCount: 38, importedCount: 38,
    liveCount: 0, fieldCount: 12, sourceExportedAt: "2026-11-20T00:00:00.000Z",
    lastRecordUpdate: "2026-11-20T00:00:00.000Z"
  });
  const page = await store.browseRecords("tblHistory", { limit: 20, offset: 0, search: "Dashboard" });
  assert.equal(page.total, 1);
  assert.equal(page.records[0].fields["Business Name"], "Dashboard Co");
  assert.deepEqual(calls[1].values, ["tblHistory", "%Dashboard%"]);
});

test("Postgres data store deletes only explicit record IDs from one table", async () => {
  const calls = [];
  const store = createPostgresDataClient({
    defaultTableId: config.airtable.tableId,
    fieldNamesByTable: airtableFieldNamesByTable,
    queryImpl: async (text, values) => {
      calls.push({ text, values });
      return values[1].map((id) => ({ id }));
    }
  });
  const deleted = await store.deleteRecordsFromTable("tblRaw", ["recOne", "recTwo", "recOne"]);
  assert.deepEqual(deleted, ["recOne", "recTwo"]);
  assert.match(calls[0].text, /DELETE FROM sitesnap_records/);
  assert.deepEqual(calls[0].values, ["tblRaw", ["recOne", "recTwo"]]);
});

test("Postgres data store installs the Overture uniqueness and status rules idempotently", async () => {
  const calls = [];
  const store = createPostgresDataClient({
    defaultTableId: config.airtable.tableId,
    fieldNamesByTable: airtableFieldNamesByTable,
    queryImpl: async (text, values) => {
      calls.push({ text, values });
      if (/HAVING COUNT\(\*\)>1/.test(text)) return [];
      return [];
    }
  });
  const result = await store.ensureLeadSchema(config.airtable.rawOutscraperTableId);
  assert.equal(result.statusConstraint, true);
  assert.equal(result.uniqueDedupKeys, true);
  assert.equal(calls.filter((call) => /CREATE UNIQUE INDEX IF NOT EXISTS/.test(call.text)).length, 3);
  assert.match(calls.at(-1).text, /VALIDATE CONSTRAINT/);
});

