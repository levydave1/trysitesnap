import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../server/config.js";
import {
  buildDashboardOverview,
  createDashboardSession,
  verifyDashboardSession
} from "../server/lead-dashboard.js";

test("dashboard sessions are signed, expire, and reject tampering", () => {
  const key = "a-long-dashboard-access-key-for-tests";
  const token = createDashboardSession(key, { now: 1_000_000 });
  assert.equal(verifyDashboardSession(token, key, { now: 1_001_000 }), true);
  assert.equal(verifyDashboardSession(`${token}x`, key, { now: 1_001_000 }), false);
  assert.equal(verifyDashboardSession(token, "different-key", { now: 1_001_000 }), false);
  assert.equal(verifyDashboardSession(token, key, { now: 1_000_000 + 13 * 60 * 60 * 1000 }), false);
});

test("dashboard overview combines Airtable history with live lead, email, and site state", async () => {
  const tables = [
    { id: config.airtable.rawOutscraperTableId, name: "Raw Outscraper", recordCount: 5961, importedCount: 5911, liveCount: 50 },
    { id: config.airtable.emailThreadsTableId, name: "Email Threads", recordCount: 4226, importedCount: 4225, liveCount: 1 },
    { id: config.airtable.tableId, name: "Generation Jobs", recordCount: 93, importedCount: 92, liveCount: 1 },
    { id: "tblOrders", name: "Orders Domains", recordCount: 1, importedCount: 1, liveCount: 0 },
    { id: "tblBusinesses", name: "Businesses", recordCount: 38, importedCount: 38, liveCount: 0 }
  ];
  const data = {
    async listTables() { return tables; },
    async listRecords(tableId) {
      if (tableId === config.airtable.rawOutscraperTableId) return [
        { id: "recPending", createdTime: "2026-11-24T10:00:00Z", fields: { "Business Name": "Pending Co", "Source System": "overture", "Lead Decision": "pending_verification", "Email Validation Status": "PENDING_EXTERNAL_VERIFICATION" } },
        { id: "recApproved", createdTime: "2026-11-23T10:00:00Z", fields: { "Business Name": "Approved Co", "Source System": "outscraper", "Lead Decision": "approved", "Email Validation Status": "GOOD" } }
      ];
      if (tableId === config.airtable.emailThreadsTableId) return [
        { id: "recThread", createdTime: "2026-11-24T11:00:00Z", fields: { "Business Name": "Approved Co", "Reply Status": "queued" } }
      ];
      return [
        { id: "recJob", createdTime: "2026-11-24T12:00:00Z", fields: { "Business Name": "Approved Co", "Generation Status": "complete", "Draft Site URL": "https://example.com" } }
      ];
    }
  };
  const overview = await buildDashboardOverview(data, config);
  assert.equal(overview.summary.totalRecords, 10319);
  assert.equal(overview.summary.importedFromAirtable, 10267);
  assert.equal(overview.summary.managedLocally, 52);
  assert.equal(overview.summary.pendingVerification, 1);
  assert.equal(overview.summary.candidates, 0);
  assert.equal(overview.summary.approved, 1);
  assert.equal(overview.summary.queuedInInstantly, 1);
  assert.equal(overview.summary.sketches, 1);
  assert.equal(overview.recent.leads[0].businessName, "Pending Co");
});
