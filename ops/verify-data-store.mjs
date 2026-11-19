import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import { airtableFieldNamesByTable, config } from "../server/config.js";
import { createPostgresDataClient } from "../server/data-store.js";

const root = resolve(import.meta.dirname, "..");
const snapshotPath = resolve(root, "..", "airtable-local-copy", "data", "snapshot.sqlite");

async function loadLocalEnv() {
  try {
    const content = await readFile(resolve(root, ".env.local"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSummary() {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  const tables = db.prepare("SELECT id,name,record_count FROM tables ORDER BY id").all();
  const records = db.prepare("SELECT id,table_id,fields_json FROM records ORDER BY table_id,id").all();
  db.close();
  const values = new Map(tables.map((table) => [table.id, []]));
  for (const record of records) values.get(record.table_id).push(`${record.id}:${sha256(record.fields_json)}`);
  return {
    tables,
    counts: Object.fromEntries(tables.map((table) => [table.id, table.record_count])),
    checksums: Object.fromEntries([...values].map(([tableId, items]) => [
      tableId,
      md5(items.sort((left, right) => left.localeCompare(right)).join("|"))
    ]))
  };
}

function destinationSummary(records) {
  const values = new Map();
  for (const record of records) {
    if (!values.has(record.table_id)) values.set(record.table_id, []);
    values.get(record.table_id).push(`${record.id}:${record.source_hash}`);
  }
  return {
    counts: Object.fromEntries([...values].map(([tableId, items]) => [tableId, items.length])),
    checksums: Object.fromEntries([...values].map(([tableId, items]) => [
      tableId,
      md5(items.sort((left, right) => left.localeCompare(right)).join("|"))
    ]))
  };
}

await loadLocalEnv();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
const sql = neon(process.env.DATABASE_URL);
const client = createPostgresDataClient({
  databaseUrl: process.env.DATABASE_URL,
  defaultTableId: config.airtable.tableId,
  fieldNamesByTable: airtableFieldNamesByTable
});
const source = sourceSummary();
const destinationRows = await sql.query(
  "SELECT table_id,id,source_hash FROM sitesnap_records WHERE source_hash IS NOT NULL",
  []
);
const destination = destinationSummary(destinationRows);
const destinationCounts = destination.counts;
const destinationChecksums = destination.checksums;
const checks = [];
for (const table of source.tables) {
  const countMatches = destinationCounts[table.id] === source.counts[table.id];
  const checksumMatches = destinationChecksums[table.id] === source.checksums[table.id];
  checks.push({ table: table.name, count: destinationCounts[table.id] || 0, countMatches, checksumMatches });
  if (!countMatches || !checksumMatches) throw new Error(`${table.name}: imported data does not match the local snapshot`);
}

const threadSample = await client.listRecords(config.airtable.emailThreadsTableId, {
  fields: [
    config.airtable.emailThreadFields.rawBusinessRecord,
    config.airtable.emailThreadFields.recipientEmail,
    config.airtable.emailThreadFields.status
  ],
  returnFieldsByFieldId: true,
  maxRecords: 3
});
for (const record of threadSample) {
  for (const key of Object.keys(record.fields)) {
    if (!key.startsWith("fld")) throw new Error(`Field-ID compatibility failed for ${key}`);
  }
}

let writeSmoke = null;
if (process.argv.includes("--write-smoke")) {
  const id = `rec${randomBytes(7).toString("hex")}`;
  try {
    await sql.query(
      "INSERT INTO sitesnap_records(id,table_id,fields) VALUES($1,$2,$3::jsonb)",
      [id, config.airtable.tableId, JSON.stringify({ "Business Name": "SiteSnap migration smoke test" })]
    );
    await client.updateRecord(id, { [config.airtable.fields.notes]: "write-read smoke test" });
    const readBack = await client.getRecord(id);
    if (readBack.fields.Notes !== "write-read smoke test") throw new Error("Write/read smoke test did not round-trip");
    writeSmoke = { success: true, recordId: id };
  } finally {
    await sql.query("DELETE FROM sitesnap_records WHERE id=$1", [id]);
  }
}

console.log(JSON.stringify({
  success: true,
  checks,
  compatibilitySample: threadSample.length,
  writeSmoke
}, null, 2));

