import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

const root = resolve(import.meta.dirname, "..");
const defaultSnapshot = resolve(root, "..", "airtable-local-copy", "data", "snapshot.sqlite");

async function loadLocalEnv() {
  const path = resolve(root, ".env.local");
  try {
    const content = await readFile(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function argument(name, fallback) {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function batches(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceChecksums(records) {
  const byTable = new Map();
  for (const record of records) {
    if (!byTable.has(record.table_id)) byTable.set(record.table_id, []);
    byTable.get(record.table_id).push(`${record.id}:${record.source_hash}`);
  }
  return Object.fromEntries([...byTable].map(([tableId, values]) => [
    tableId,
    md5(values.sort((left, right) => left.localeCompare(right)).join("|"))
  ]));
}

async function createSchema(sql) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS sitesnap_tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0,
      field_count INTEGER NOT NULL DEFAULT 0,
      source_exported_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS sitesnap_fields (
      table_id TEXT NOT NULL REFERENCES sitesnap_tables(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY(table_id,name)
    )`,
    `CREATE TABLE IF NOT EXISTS sitesnap_records (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES sitesnap_tables(id),
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_hash TEXT
    )`,
    "CREATE INDEX IF NOT EXISTS sitesnap_records_table_created_idx ON sitesnap_records(table_id,created_at,id)",
    `CREATE TABLE IF NOT EXISTS sitesnap_assets (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES sitesnap_records(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_url TEXT,
      local_path TEXT,
      object_url TEXT,
      status TEXT NOT NULL,
      mime_type TEXT,
      size BIGINT,
      error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    "CREATE INDEX IF NOT EXISTS sitesnap_assets_record_idx ON sitesnap_assets(record_id)",
    `CREATE TABLE IF NOT EXISTS sitesnap_imports (
      id UUID PRIMARY KEY,
      source TEXT NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      counts JSONB NOT NULL,
      checksums JSONB NOT NULL
    )`
  ];
  for (const statement of statements) await sql.query(statement, []);
}

await loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not configured; add it to website/.env.local or the shell environment");
const snapshotPath = resolve(argument("--sqlite", defaultSnapshot));
await access(snapshotPath);

const db = new DatabaseSync(snapshotPath, { readOnly: true });
const tables = db.prepare("SELECT * FROM tables ORDER BY name").all();
const fields = db.prepare("SELECT table_id,name,type,position FROM fields ORDER BY table_id,position").all();
const sourceRecords = db.prepare("SELECT id,table_id,fields_json,airtable_created_at FROM records ORDER BY table_id,id").all()
  .map((record) => ({
    ...record,
    created_at: record.airtable_created_at || new Date(0).toISOString(),
    source_hash: sha256(record.fields_json)
  }));
const assets = db.prepare("SELECT id,record_id,table_id,field_name,kind,source_url,local_path,status,mime_type,size,error FROM assets ORDER BY id").all();
db.close();

const sql = neon(databaseUrl);
await createSchema(sql);

for (const table of tables) {
  await sql.query(
    `INSERT INTO sitesnap_tables(id,name,record_count,field_count,source_exported_at)
     VALUES($1,$2,$3,$4,$5::timestamptz)
     ON CONFLICT(id) DO UPDATE SET
       name=EXCLUDED.name, record_count=EXCLUDED.record_count,
       field_count=EXCLUDED.field_count, source_exported_at=EXCLUDED.source_exported_at,
       updated_at=NOW()`,
    [table.id, table.name, table.record_count, table.field_count, table.exported_at || null]
  );
}

for (const group of batches(fields, 100)) {
  const values = [];
  const placeholders = group.map((field, index) => {
    const offset = index * 4;
    values.push(field.table_id, field.name, field.type, field.position);
    return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4})`;
  });
  await sql.query(
    `INSERT INTO sitesnap_fields(table_id,name,type,position) VALUES ${placeholders.join(",")}
     ON CONFLICT(table_id,name) DO UPDATE SET type=EXCLUDED.type,position=EXCLUDED.position`,
    values
  );
}

let importedRecords = 0;
for (const group of batches(sourceRecords, 100)) {
  const values = [];
  const placeholders = group.map((record, index) => {
    const offset = index * 5;
    values.push(record.id, record.table_id, record.fields_json, record.created_at, record.source_hash);
    return `($${offset + 1},$${offset + 2},$${offset + 3}::jsonb,$${offset + 4}::timestamptz,$${offset + 5})`;
  });
  await sql.query(
    `INSERT INTO sitesnap_records(id,table_id,fields,created_at,source_hash)
     VALUES ${placeholders.join(",")}
     ON CONFLICT(id) DO UPDATE SET
       table_id=EXCLUDED.table_id, fields=EXCLUDED.fields, created_at=EXCLUDED.created_at,
       updated_at=NOW(), source_hash=EXCLUDED.source_hash`,
    values
  );
  importedRecords += group.length;
  if (importedRecords % 1000 === 0 || importedRecords === sourceRecords.length) {
    console.log(`Records: ${importedRecords}/${sourceRecords.length}`);
  }
}

let importedAssets = 0;
for (const group of batches(assets, 100)) {
  const values = [];
  const placeholders = group.map((asset, index) => {
    const offset = index * 11;
    values.push(
      asset.id, asset.record_id, asset.table_id, asset.field_name, asset.kind,
      asset.source_url, asset.local_path, asset.status, asset.mime_type, asset.size, asset.error
    );
    return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11})`;
  });
  await sql.query(
    `INSERT INTO sitesnap_assets(
      id,record_id,table_id,field_name,kind,source_url,local_path,status,mime_type,size,error
    ) VALUES ${placeholders.join(",")}
    ON CONFLICT(id) DO UPDATE SET
      record_id=EXCLUDED.record_id, table_id=EXCLUDED.table_id,
      field_name=EXCLUDED.field_name, kind=EXCLUDED.kind, source_url=EXCLUDED.source_url,
      local_path=EXCLUDED.local_path, status=EXCLUDED.status, mime_type=EXCLUDED.mime_type,
      size=EXCLUDED.size, error=EXCLUDED.error, updated_at=NOW()`,
    values
  );
  importedAssets += group.length;
  if (importedAssets % 1000 === 0 || importedAssets === assets.length) {
    console.log(`Assets: ${importedAssets}/${assets.length}`);
  }
}

const expectedCounts = Object.fromEntries(tables.map((table) => [table.id, table.record_count]));
const expectedChecksums = sourceChecksums(sourceRecords);
const actualRows = await sql.query(
  "SELECT table_id,id,source_hash FROM sitesnap_records WHERE source_hash IS NOT NULL",
  []
);
const actualCounts = {};
for (const row of actualRows) actualCounts[row.table_id] = (actualCounts[row.table_id] || 0) + 1;
// Compute both sides in JavaScript. Database collations order mixed-case Airtable
// record IDs differently, which would otherwise create a false checksum failure.
const actualChecksums = sourceChecksums(actualRows);
for (const table of tables) {
  if (actualCounts[table.id] !== expectedCounts[table.id]) {
    throw new Error(`${table.name}: expected ${expectedCounts[table.id]} records, found ${actualCounts[table.id] || 0}`);
  }
  if (actualChecksums[table.id] !== expectedChecksums[table.id]) {
    throw new Error(`${table.name}: record checksum mismatch`);
  }
}

const counts = {
  tables: tables.length,
  fields: fields.length,
  records: sourceRecords.length,
  assets: assets.length,
  byTable: Object.fromEntries(tables.map((table) => [table.name, expectedCounts[table.id]]))
};
await sql.query(
  "INSERT INTO sitesnap_imports(id,source,counts,checksums) VALUES($1,$2,$3::jsonb,$4::jsonb)",
  [randomUUID(), snapshotPath, JSON.stringify(counts), JSON.stringify(expectedChecksums)]
);
console.log(JSON.stringify({ success: true, counts, checksums: expectedChecksums }, null, 2));

