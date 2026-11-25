import assert from "node:assert/strict";
import test from "node:test";
import { planSafeUnsentLeadDedupe } from "../server/lead-dedupe.js";

function raw(id, createdTime, overrides = {}) {
  return {
    id,
    createdTime,
    fields: {
      Email: "same@example.com",
      "Place ID": "place-1",
      "Business Name": "Same Business",
      Website: "https://same.example",
      "Source Run Name": "Outscraper run 1",
      "Source System": "outscraper",
      "Email Status": "not_started",
      "Email Eligible": "yes",
      ...overrides
    }
  };
}

test("safe unsent dedupe keeps the earliest exact record and protects contacted or non-identical leads", () => {
  const records = [
    raw("recKeep", "2026-09-23T08:05:57Z"),
    raw("recDelete", "2026-09-23T08:06:17Z"),
    raw("recDifferent", "2026-09-23T08:06:18Z", { Website: "https://different.example" }),
    raw("recContacted", "2026-09-23T08:06:19Z", { Email: "contacted@example.com", "Place ID": "place-2" }),
    raw("recContactedCopy", "2026-09-23T08:06:20Z", { Email: "contacted@example.com", "Place ID": "place-2" })
  ];
  const plan = planSafeUnsentLeadDedupe(records, [{
    id: "thread-1",
    fields: { "Business ID": "recContacted", "To Email": "contacted@example.com" }
  }]);
  assert.equal(plan.scanned, 5);
  assert.equal(plan.duplicateGroups, 1);
  assert.equal(plan.keepCount, 2);
  assert.deepEqual(plan.deleteIds, ["recDelete"]);
});

