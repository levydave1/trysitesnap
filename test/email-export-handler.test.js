import test from "node:test";
import assert from "node:assert/strict";
import { isForceExportRequest } from "../server/email-export-handler.js";

test("force export is explicit and disabled by default", () => {
  assert.equal(isForceExportRequest({ query: {}, url: "/api/02-export-email-to-instantly" }), false);
  assert.equal(isForceExportRequest({ query: { force_export: "0" }, url: "/api/02-export-email-to-instantly?force_export=0" }), false);
});

test("force export accepts parsed query or the raw cron URL", () => {
  assert.equal(isForceExportRequest({ query: { force_export: "1" }, url: "/api/02-export-email-to-instantly" }), true);
  assert.equal(isForceExportRequest({ query: {}, url: "/api/02-export-email-to-instantly?max_records=50&force_export=1" }), true);
});
