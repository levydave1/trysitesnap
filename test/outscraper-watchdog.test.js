import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../server/config.js";
import { recentOutscraperImport, runOutscraperWatchdog } from "../server/outscraper-watchdog.js";

function dependencies(overrides = {}) {
  return {
    config,
    airtable: {
      async listRecords() { return []; }
    },
    outscraper: {
      async listFinishedRequests() { return []; },
      async listRequests() { return []; },
      async startGoogleMapsSearch() { throw new Error("unexpected fallback"); }
    },
    telegram: null,
    ...overrides
  };
}

test("watchdog recognizes a recent Outscraper import", () => {
  const now = new Date("2026-08-30T11:00:00Z");
  assert.equal(recentOutscraperImport([{ fields: {
    "Source System": "outscraper",
    "Last Seen At": "2026-08-30T08:00:00Z"
  } }], now, 20), true);
  assert.equal(recentOutscraperImport([{ fields: {
    "Source System": "website",
    "Last Seen At": "2026-08-30T08:00:00Z"
  } }], now, 20), false);
});

test("watchdog does not start another scrape while an API request is active", async () => {
  const result = await runOutscraperWatchdog({ headers: { host: "example.test" } }, dependencies({
    outscraper: {
      async listFinishedRequests() { return []; },
      async listRequests() { return [{ id: "active-1" }]; },
      async startGoogleMapsSearch() { throw new Error("unexpected fallback"); }
    }
  }), { now: new Date("2026-08-30T11:00:00Z") });
  assert.equal(result.action, "active_request");
});

test("watchdog starts the matching regional fallback when the scheduled import is missing", async () => {
  let submitted;
  const result = await runOutscraperWatchdog({ headers: { host: "project.example" } }, dependencies({
    outscraper: {
      async listFinishedRequests() { return []; },
      async listRequests() { return []; },
      async startGoogleMapsSearch(options) {
        submitted = options;
        return { id: "fallback-1", status: "Pending" };
      }
    }
  }), { now: new Date("2026-08-30T11:00:00Z") });
  assert.equal(result.action, "fallback_started");
  assert.equal(result.title, "SiteSnap Daily Sat West Coast");
  assert.equal(submitted.queries.length, 24);
  assert.equal(submitted.totalLimit, 240);
  assert.equal(submitted.webhook, `https://project.example${config.outscraper.webhookPath}`);
});
