import { createAirtableClient } from "./clients.js";
import { config } from "./config.js";
import { createNeonMirrorClient } from "./airtable-mirror.js";

export async function reconcileAirtable({ airtable, mirror, tables, dryRun = false }) {
  if (!mirror) {
    const error = new Error("DATABASE_URL is not configured");
    error.code = "MIRROR_DATABASE_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
  const snapshots = [];
  for (const table of tables) {
    snapshots.push({
      ...table,
      records: await airtable.listRecords(table.id, { returnFieldsByFieldId: true })
    });
  }
  return mirror.reconcileSnapshot({ tables: snapshots, dryRun });
}

export function createAirtableReconciliationDependencies() {
  return {
    airtable: createAirtableClient({
      baseId: config.airtable.baseId,
      tableId: config.airtable.tableId,
      accessToken: process.env.AIRTABLE_ACCESS_TOKEN,
      timeoutMs: config.upstreamTimeoutMs
    }),
    mirror: createNeonMirrorClient({ databaseUrl: process.env.DATABASE_URL }),
    tables: config.airtable.mirrorTables
  };
}
