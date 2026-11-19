import assert from "node:assert/strict";
import test from "node:test";
import { checkDataStore } from "../server/data-store-health.js";

test("health check reports the active Postgres store after a real query", async () => {
  let checks = 0;
  const result = await checkDataStore({
    dataBackend: "postgres",
    airtable: {
      async healthCheck() {
        checks += 1;
        return { reachable: true };
      }
    },
    config: { airtable: {} }
  });
  assert.equal(checks, 1);
  assert.deepEqual(result, {
    success: true,
    backend: "postgres",
    database: "reachable"
  });
});

test("health check retains an Airtable rollback path", async () => {
  const calls = [];
  const result = await checkDataStore({
    dataBackend: "airtable",
    airtable: {
      async listRecords(tableId, options) {
        calls.push({ tableId, options });
        return [];
      }
    },
    config: {
      airtable: {
        tableId: "tblJobs",
        fields: { jobBusinessName: "fldBusiness" }
      }
    }
  });
  assert.deepEqual(calls, [{
    tableId: "tblJobs",
    options: { fields: ["fldBusiness"], maxRecords: 1 }
  }]);
  assert.equal(result.backend, "airtable");
});
