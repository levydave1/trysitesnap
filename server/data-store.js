import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

function resultRows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

function recordNotFound(recordId) {
  const error = new Error(`Record ${recordId} was not found`);
  error.code = "RECORD_NOT_FOUND";
  error.status = 404;
  return error;
}

function recordId() {
  return `rec${randomBytes(7).toString("hex")}`;
}

function asFields(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function isoTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function rowRecord(row) {
  return {
    id: row.id,
    createdTime: isoTime(row.created_at),
    fields: asFields(row.fields)
  };
}

function fieldMaps(fieldNamesByTable, tableId) {
  const idToName = fieldNamesByTable[tableId] || {};
  return {
    idToName,
    nameToId: Object.fromEntries(Object.entries(idToName).map(([id, name]) => [name, id]))
  };
}

function canonicalFieldName(fieldNamesByTable, tableId, key) {
  const name = fieldNamesByTable[tableId]?.[key];
  if (name) return name;
  if (String(key).startsWith("fld")) {
    throw new Error(`Unknown Airtable field ID ${key} for table ${tableId}`);
  }
  return key;
}

function canonicalFields(fieldNamesByTable, tableId, fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [
    canonicalFieldName(fieldNamesByTable, tableId, key),
    value
  ]));
}

function projectRecord(record, options, fieldNamesByTable, tableId) {
  const requested = options.fields || [];
  if (!requested.length && !options.returnFieldsByFieldId) return record;
  const { idToName, nameToId } = fieldMaps(fieldNamesByTable, tableId);
  const names = requested.length
    ? requested.map((field) => idToName[field] || field)
    : Object.keys(record.fields);
  const fields = {};
  for (const name of names) {
    if (!(name in record.fields)) continue;
    const key = options.returnFieldsByFieldId ? (nameToId[name] || name) : name;
    fields[key] = record.fields[name];
  }
  return { ...record, fields };
}

function filterRecords(records, formula) {
  if (!formula) return records;
  const firstSketch = formula.match(
    /^AND\(\{Business Name\}!="",\{Draft Site URL\}="",IS_AFTER\(CREATED_TIME\(\),'([^']+)'\)\)$/
  );
  if (!firstSketch) throw new Error(`Unsupported data-store filter formula: ${formula}`);
  const cutover = Date.parse(firstSketch[1]);
  if (!Number.isFinite(cutover)) throw new Error("Invalid first-sketch cutover time");
  return records.filter((record) =>
    String(record.fields["Business Name"] || "").trim()
    && !String(record.fields["Draft Site URL"] || "").trim()
    && Date.parse(record.createdTime) > cutover
  );
}

function sortRecords(records, sorts = []) {
  if (!sorts.length) return records;
  return [...records].sort((left, right) => {
    for (const sort of sorts) {
      const direction = String(sort.direction || "asc").toLowerCase() === "desc" ? -1 : 1;
      const field = sort.field;
      const leftValue = field === "Created At"
        ? (left.fields[field] || left.createdTime)
        : left.fields[field];
      const rightValue = field === "Created At"
        ? (right.fields[field] || right.createdTime)
        : right.fields[field];
      const compared = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
      if (compared) return compared * direction;
    }
    return left.id.localeCompare(right.id);
  });
}

export function createPostgresDataClient({
  databaseUrl,
  defaultTableId,
  fieldNamesByTable = {},
  queryImpl
}) {
  if (!queryImpl && !databaseUrl) throw new Error("DATABASE_URL is not configured");
  const sql = queryImpl ? null : neon(databaseUrl);
  const query = queryImpl || ((text, values = []) => sql.query(text, values));

  async function getRecordFromTable(tableId, id) {
    const rows = resultRows(await query(
      "SELECT id, fields, created_at FROM sitesnap_records WHERE id=$1 AND table_id=$2 LIMIT 1",
      [id, tableId]
    ));
    if (!rows.length) throw recordNotFound(id);
    return rowRecord(rows[0]);
  }

  async function listRecords(tableId, options = {}) {
    const requestedNames = (options.fields || []).map((field) =>
      canonicalFieldName(fieldNamesByTable, tableId, field)
    );
    const rows = requestedNames.length
      ? resultRows(await query(
          `SELECT id, created_at,
            COALESCE((
              SELECT jsonb_object_agg(entry.key, entry.value)
              FROM jsonb_each(fields) AS entry
              WHERE entry.key IN (SELECT jsonb_array_elements_text($2::jsonb))
            ), '{}'::jsonb) AS fields
          FROM sitesnap_records
          WHERE table_id=$1
          ORDER BY created_at ASC, id ASC`,
          [tableId, JSON.stringify(requestedNames)]
        ))
      : resultRows(await query(
          "SELECT id, fields, created_at FROM sitesnap_records WHERE table_id=$1 ORDER BY created_at ASC, id ASC",
          [tableId]
        ));
    let records = rows.map(rowRecord);
    records = filterRecords(records, options.filterByFormula);
    records = sortRecords(records, options.sort);
    if (options.maxRecords) records = records.slice(0, Math.max(0, Number(options.maxRecords) || 0));
    return records.map((record) => projectRecord(record, options, fieldNamesByTable, tableId));
  }

  async function listTables() {
    return resultRows(await query(
      `SELECT t.id, t.name, COUNT(r.id)::bigint AS record_count,
              COUNT(r.id) FILTER (WHERE r.source_hash IS NOT NULL)::bigint AS imported_count,
              COUNT(r.id) FILTER (WHERE r.source_hash IS NULL)::bigint AS live_count,
              t.field_count, t.source_exported_at, MAX(r.updated_at) AS last_record_update
       FROM sitesnap_tables t
       LEFT JOIN sitesnap_records r ON r.table_id=t.id
       GROUP BY t.id, t.name, t.field_count, t.source_exported_at
       ORDER BY t.name ASC`,
      []
    )).map((row) => ({
      id: row.id,
      name: row.name,
      recordCount: Number(row.record_count) || 0,
      importedCount: Number(row.imported_count) || 0,
      liveCount: Number(row.live_count) || 0,
      fieldCount: Number(row.field_count) || 0,
      sourceExportedAt: isoTime(row.source_exported_at),
      lastRecordUpdate: isoTime(row.last_record_update)
    }));
  }

  async function browseRecords(tableId, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
    const offset = Math.max(0, Number(options.offset) || 0);
    const search = String(options.search || "").trim().slice(0, 120);
    const pattern = search ? `%${search}%` : "";
    const countRows = resultRows(await query(
      `SELECT COUNT(*)::bigint AS total
       FROM sitesnap_records
       WHERE table_id=$1 AND ($2='' OR fields::text ILIKE $2)`,
      [tableId, pattern]
    ));
    const rows = resultRows(await query(
      `SELECT id, fields, created_at
       FROM sitesnap_records
       WHERE table_id=$1 AND ($2='' OR fields::text ILIKE $2)
       ORDER BY created_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [tableId, pattern, limit, offset]
    ));
    return {
      total: Number(countRows[0]?.total) || 0,
      limit,
      offset,
      records: rows.map(rowRecord)
    };
  }

  async function updateRecordInTable(tableId, id, fields) {
    const canonical = canonicalFields(fieldNamesByTable, tableId, fields);
    const rows = resultRows(await query(
      `UPDATE sitesnap_records
       SET fields=fields || $3::jsonb, updated_at=NOW(), source_hash=NULL
       WHERE id=$1 AND table_id=$2
       RETURNING id, fields, created_at`,
      [id, tableId, JSON.stringify(canonical)]
    ));
    if (!rows.length) throw recordNotFound(id);
    return rowRecord(rows[0]);
  }

  async function updateRecord(id, fields) {
    return updateRecordInTable(defaultTableId, id, fields);
  }

  async function deleteRecordsFromTable(tableId, recordIds) {
    const ids = [...new Set((recordIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return [];
    if (ids.length > 1000) throw new Error("Data-store delete is limited to 1000 records");
    const rows = resultRows(await query(
      `DELETE FROM sitesnap_records
       WHERE table_id=$1 AND id=ANY($2::text[])
       RETURNING id`,
      [tableId, ids]
    ));
    return rows.map((row) => row.id);
  }

  async function createRecords(tableId, records, options = {}) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 10) {
      throw new Error("Data-store batch must contain between 1 and 10 records");
    }
    const now = new Date().toISOString();
    const values = [];
    const placeholders = records.map((fields, index) => {
      const offset = index * 4;
      values.push(recordId(), tableId, JSON.stringify(canonicalFields(fieldNamesByTable, tableId, fields)), now);
      return `($${offset + 1},$${offset + 2},$${offset + 3}::jsonb,$${offset + 4}::timestamptz)`;
    });
    const conflictClause = options.skipConflicts ? " ON CONFLICT DO NOTHING" : "";
    const rows = resultRows(await query(
      `INSERT INTO sitesnap_records(id,table_id,fields,created_at)
       VALUES ${placeholders.join(",")}${conflictClause}
       RETURNING id, fields, created_at`,
      values
    ));
    return rows.map(rowRecord);
  }

  async function ensureLeadSchema(tableId) {
    await query(
      `UPDATE sitesnap_records
       SET fields = fields || jsonb_build_object(
         'Lead Status', CASE
           WHEN LOWER(fields->>'Lead Decision')='approved' THEN 'approved'
           WHEN LOWER(fields->>'Lead Decision')='rejected' THEN 'rejected'
           WHEN LOWER(fields->>'Lead Decision')='pending_verification' THEN 'enriched'
           WHEN LOWER(fields->>'Lead Decision')='pending_enrichment' THEN 'candidate'
           ELSE 'candidate'
         END,
         'Lead Status Updated At', COALESCE(NULLIF(fields->>'Lead Status Updated At',''), updated_at::text),
         'Lead Decision Reason', COALESCE(
           NULLIF(fields->>'Lead Decision Reason',''),
           NULLIF(fields->>'Lead Rejection Reason',''),
           UPPER(COALESCE(NULLIF(fields->>'Lead Decision',''), 'IMPORTED'))
         )
       ), updated_at=NOW()
       WHERE table_id=$1
         AND LOWER(fields->>'Source System')='overture'
         AND COALESCE(fields->>'Lead Status','')=''`,
      [tableId]
    );
    const duplicatePlaces = resultRows(await query(
      `SELECT LOWER(fields->>'Place ID') AS value, COUNT(*)::int AS count
       FROM sitesnap_records
       WHERE table_id=$1 AND LOWER(fields->>'Source System')='overture'
         AND COALESCE(fields->>'Place ID','')<>''
       GROUP BY LOWER(fields->>'Place ID') HAVING COUNT(*)>1 LIMIT 20`,
      [tableId]
    ));
    const duplicateDedupKeys = resultRows(await query(
      `SELECT LOWER(fields->>'Dedup Key') AS value, COUNT(*)::int AS count
       FROM sitesnap_records
       WHERE table_id=$1 AND LOWER(fields->>'Source System')='overture'
         AND COALESCE(fields->>'Dedup Key','')<>''
       GROUP BY LOWER(fields->>'Dedup Key') HAVING COUNT(*)>1 LIMIT 20`,
      [tableId]
    ));
    const duplicateEmails = resultRows(await query(
      `SELECT LOWER(fields->>'Email') AS value, COUNT(*)::int AS count
       FROM sitesnap_records
       WHERE table_id=$1 AND LOWER(fields->>'Source System')='overture'
         AND COALESCE(fields->>'Email','')<>''
       GROUP BY LOWER(fields->>'Email') HAVING COUNT(*)>1 LIMIT 20`,
      [tableId]
    ));
    if (duplicatePlaces.length || duplicateDedupKeys.length || duplicateEmails.length) {
      const error = new Error("Overture duplicates must be resolved before adding unique indexes");
      error.code = "OVERTURE_DUPLICATES_BLOCK_SCHEMA";
      error.details = { placeIds: duplicatePlaces, dedupKeys: duplicateDedupKeys, emails: duplicateEmails };
      throw error;
    }
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS sitesnap_overture_place_unique_idx
       ON sitesnap_records(table_id,LOWER(fields->>'Place ID'))
       WHERE LOWER(fields->>'Source System')='overture' AND COALESCE(fields->>'Place ID','')<>''`,
      []
    );
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS sitesnap_overture_dedup_key_unique_idx
       ON sitesnap_records(table_id,LOWER(fields->>'Dedup Key'))
       WHERE LOWER(fields->>'Source System')='overture' AND COALESCE(fields->>'Dedup Key','')<>''`,
      []
    );
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS sitesnap_overture_email_unique_idx
       ON sitesnap_records(table_id,LOWER(fields->>'Email'))
       WHERE LOWER(fields->>'Source System')='overture' AND COALESCE(fields->>'Email','')<>''`,
      []
    );
    await query(
      `DO $$ BEGIN
         ALTER TABLE sitesnap_records ADD CONSTRAINT sitesnap_overture_lead_status_check CHECK (
           LOWER(fields->>'Source System')<>'overture'
           OR LOWER(fields->>'Lead Status') IN ('candidate','enriched','verified','approved','transferred','sent','rejected')
         ) NOT VALID;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END $$`,
      []
    );
    await query("ALTER TABLE sitesnap_records VALIDATE CONSTRAINT sitesnap_overture_lead_status_check", []);
    return {
      tableId,
      uniquePlaceIds: true,
      uniqueDedupKeys: true,
      uniqueOvertureEmails: true,
      statusConstraint: true
    };
  }

  return {
    async healthCheck() {
      await query("SELECT COUNT(*)::bigint AS record_count FROM sitesnap_records");
      return { reachable: true };
    },
    getRecord(id) {
      return getRecordFromTable(defaultTableId, id);
    },
    getRecordFromTable,
    listRecords,
    listTables,
    browseRecords,
    updateRecord,
    updateRecordInTable,
    deleteRecordsFromTable,
    ensureLeadSchema,
    async createRecord(tableId, fields) {
      return (await createRecords(tableId, [fields]))[0];
    },
    createRecords
  };
}

