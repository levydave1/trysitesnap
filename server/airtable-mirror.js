import { createHash, randomUUID } from "node:crypto";

function stableValue(value, insideAttachment = false) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item, insideAttachment));
  if (value && typeof value === "object") {
    const isAttachment = insideAttachment || (
      typeof value.id === "string"
      && typeof value.url === "string"
      && (typeof value.filename === "string" || typeof value.type === "string")
    );
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !(isAttachment && key === "url"))
        .sort()
        .map((key) => [key, stableValue(value[key], isAttachment)])
    );
  }
  return value;
}

export function recordChecksum(fields) {
  return createHash("sha256").update(JSON.stringify(stableValue(fields || {}))).digest("hex");
}

function mirrorFailure(logger, event, error) {
  logger?.error?.(JSON.stringify({
    event: "airtable_mirror_failed",
    operation: event.operation,
    tableId: event.tableId,
    recordId: event.recordId,
    message: String(error?.message || error)
  }));
}

export function createNeonMirrorClient({ databaseUrl, neonImpl } = {}) {
  if (!databaseUrl) return null;
  let sqlPromise;
  let schemaPromise;

  async function getSql() {
    if (!sqlPromise) {
      sqlPromise = neonImpl
        ? Promise.resolve(neonImpl(databaseUrl))
        : import("@neondatabase/serverless").then(({ neon }) => neon(databaseUrl));
    }
    return sqlPromise;
  }

  async function ensureSchema(sql) {
    if (!schemaPromise) {
      schemaPromise = sql.transaction([
        sql`
          CREATE TABLE IF NOT EXISTS airtable_mirror_records (
            table_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            fields JSONB NOT NULL,
            last_operation TEXT NOT NULL,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL,
            checksum TEXT,
            airtable_created_at TIMESTAMPTZ,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            present_in_airtable BOOLEAN NOT NULL DEFAULT TRUE,
            PRIMARY KEY (table_id, record_id)
          )
        `,
        sql`
          ALTER TABLE airtable_mirror_records
            ADD COLUMN IF NOT EXISTS checksum TEXT,
            ADD COLUMN IF NOT EXISTS airtable_created_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ADD COLUMN IF NOT EXISTS present_in_airtable BOOLEAN NOT NULL DEFAULT TRUE
        `,
        sql`
          CREATE TABLE IF NOT EXISTS airtable_mirror_events (
            event_id UUID PRIMARY KEY,
            occurred_at TIMESTAMPTZ NOT NULL,
            source TEXT NOT NULL,
            operation TEXT NOT NULL,
            table_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            fields JSONB NOT NULL
          )
        `,
        sql`
          CREATE INDEX IF NOT EXISTS airtable_mirror_events_record_idx
          ON airtable_mirror_events (table_id, record_id, occurred_at DESC)
        `,
        sql`
          CREATE TABLE IF NOT EXISTS airtable_reconciliation_runs (
            run_id UUID PRIMARY KEY,
            started_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ NOT NULL,
            dry_run BOOLEAN NOT NULL,
            source TEXT NOT NULL,
            summary JSONB NOT NULL
          )
        `
      ]).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  }

  return {
    async record(event) {
      if (!event.recordId) throw new Error("Mirror event is missing an Airtable record ID");
      const sql = await getSql();
      await ensureSchema(sql);
      const eventId = event.eventId || randomUUID();
      const fields = JSON.stringify(event.fields || {});
      const checksum = recordChecksum(event.fields);
      await sql.transaction([
        sql`
          INSERT INTO airtable_mirror_events
            (event_id, occurred_at, source, operation, table_id, record_id, fields)
          VALUES
            (${eventId}, ${event.occurredAt}, ${event.source}, ${event.operation}, ${event.tableId}, ${event.recordId}, ${fields}::jsonb)
        `,
        sql`
          INSERT INTO airtable_mirror_records
            (table_id, record_id, fields, last_operation, updated_at, checksum, last_seen_at, present_in_airtable)
          VALUES
            (${event.tableId}, ${event.recordId}, ${fields}::jsonb, ${event.operation}, ${event.occurredAt}, ${checksum}, ${event.occurredAt}, TRUE)
          ON CONFLICT (table_id, record_id) DO UPDATE SET
            fields = EXCLUDED.fields,
            last_operation = EXCLUDED.last_operation,
            updated_at = EXCLUDED.updated_at,
            checksum = EXCLUDED.checksum,
            last_seen_at = EXCLUDED.last_seen_at,
            present_in_airtable = TRUE
        `
      ]);
    },

    async reconcileSnapshot({ tables, dryRun = false, source = "airtable_full_scan", startedAt = new Date().toISOString() }) {
      const sql = await getSql();
      await ensureSchema(sql);
      const tableResults = [];

      for (const table of tables) {
        const currentRows = await sql`
          SELECT record_id, checksum, present_in_airtable
          FROM airtable_mirror_records
          WHERE table_id = ${table.id}
        `;
        const current = new Map(currentRows.map((row) => [row.record_id, row]));
        const normalized = table.records.map((record) => ({
          record_id: record.id,
          fields: record.fields || {},
          checksum: recordChecksum(record.fields),
          created_time: record.createdTime || null
        }));
        const incomingIds = new Set(normalized.map((record) => record.record_id));
        const created = normalized.filter((record) => !current.has(record.record_id)).length;
        const changed = normalized.filter((record) => {
          const row = current.get(record.record_id);
          return row && (row.checksum !== record.checksum || row.present_in_airtable === false);
        }).length;
        const unchanged = normalized.length - created - changed;
        const missing = [...current.keys()].filter((recordId) => !incomingIds.has(recordId)).length;

        if (!dryRun) {
          for (let index = 0; index < normalized.length; index += 250) {
            const recordsJson = JSON.stringify(normalized.slice(index, index + 250));
            await sql`
              INSERT INTO airtable_mirror_records
                (table_id, record_id, fields, last_operation, updated_at, checksum, airtable_created_at, last_seen_at, present_in_airtable)
              SELECT
                ${table.id}, x.record_id, x.fields, 'reconcile', NOW(), x.checksum, x.created_time, NOW(), TRUE
              FROM jsonb_to_recordset(${recordsJson}::jsonb)
                AS x(record_id TEXT, fields JSONB, checksum TEXT, created_time TIMESTAMPTZ)
              ON CONFLICT (table_id, record_id) DO UPDATE SET
                fields = EXCLUDED.fields,
                last_operation = 'reconcile',
                updated_at = CASE
                  WHEN airtable_mirror_records.checksum IS DISTINCT FROM EXCLUDED.checksum
                    OR airtable_mirror_records.present_in_airtable = FALSE
                  THEN NOW() ELSE airtable_mirror_records.updated_at END,
                checksum = EXCLUDED.checksum,
                airtable_created_at = COALESCE(airtable_mirror_records.airtable_created_at, EXCLUDED.airtable_created_at),
                last_seen_at = NOW(),
                present_in_airtable = TRUE
            `;
          }
          if (incomingIds.size) {
            await sql`
              UPDATE airtable_mirror_records
              SET present_in_airtable = FALSE,
                  last_operation = 'missing_from_airtable',
                  updated_at = CASE WHEN present_in_airtable THEN NOW() ELSE updated_at END
              WHERE table_id = ${table.id}
                AND NOT (record_id = ANY(${[...incomingIds]}::text[]))
            `;
          } else {
            await sql`
              UPDATE airtable_mirror_records
              SET present_in_airtable = FALSE,
                  last_operation = 'missing_from_airtable',
                  updated_at = CASE WHEN present_in_airtable THEN NOW() ELSE updated_at END
              WHERE table_id = ${table.id}
            `;
          }
        }

        tableResults.push({
          name: table.name,
          tableId: table.id,
          airtable: normalized.length,
          mirrorBefore: current.size,
          created,
          changed,
          unchanged,
          missing
        });
      }

      const result = {
        runId: randomUUID(),
        source,
        dryRun,
        startedAt,
        completedAt: new Date().toISOString(),
        tables: tableResults,
        totals: tableResults.reduce((totals, table) => {
          for (const key of ["airtable", "mirrorBefore", "created", "changed", "unchanged", "missing"]) {
            totals[key] += table[key];
          }
          return totals;
        }, { airtable: 0, mirrorBefore: 0, created: 0, changed: 0, unchanged: 0, missing: 0 })
      };
      if (!dryRun) {
        await sql`
          INSERT INTO airtable_reconciliation_runs
            (run_id, started_at, completed_at, dry_run, source, summary)
          VALUES
            (${result.runId}, ${result.startedAt}, ${result.completedAt}, FALSE, ${source}, ${JSON.stringify(result)}::jsonb)
        `;
      }
      return result;
    }
  };
}

export function createMirroredAirtableClient({ airtable, mirror, defaultTableId, logger = console }) {
  if (!mirror) return airtable;

  async function recordAfterAirtable(event) {
    try {
      await mirror.record({
        version: 1,
        source: "airtable",
        occurredAt: new Date().toISOString(),
        ...event
      });
    } catch (error) {
      mirrorFailure(logger, event, error);
    }
  }

  return {
    ...airtable,
    async updateRecord(recordId, fields) {
      const result = await airtable.updateRecord(recordId, fields);
      await recordAfterAirtable({
        operation: "update",
        tableId: defaultTableId,
        recordId: result?.id || recordId,
        fields: result?.fields || fields
      });
      return result;
    },
    async createRecord(tableId, fields) {
      const result = await airtable.createRecord(tableId, fields);
      await recordAfterAirtable({
        operation: "create",
        tableId,
        recordId: result?.id || null,
        fields: result?.fields || fields
      });
      return result;
    }
  };
}

export function withOptionalAirtableMirror(airtable, { defaultTableId, logger = console } = {}) {
  const mirror = createNeonMirrorClient({
    databaseUrl: process.env.DATABASE_URL
  });
  return createMirroredAirtableClient({ airtable, mirror, defaultTableId, logger });
}
