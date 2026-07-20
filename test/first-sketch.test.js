import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../server/config.js";
import { runFirstSketch, verifyTestOpenToken } from "../server/first-sketch.js";

process.env.LOCAL_TELEGRAM_RELAY_SECRET ||= "test-relay-secret";

function dependencies(overrides = {}) {
  const calls = { updates: [], mail: [], telegram: [], deployments: [] };
  return {
    calls,
    config,
    airtable: {
      async getRecord() {
        return { id: "recABCDEFGHIJKLMN", fields: { "Business ID": "recNOPQRSTUVWXYZ1", "Business Name": "Acme Roofing" } };
      },
      async getRecordFromTable() {
        return { id: "recNOPQRSTUVWXYZ1", fields: {
          "Business Name": "Acme Roofing", Category: "Roofing", Phone: "2125550199",
          Address: "1 Main St", City: "New York", State: "NY", Email: "customer@example.com"
        } };
      },
      async updateRecord(id, fields) { calls.updates.push({ id, fields }); }
    },
    tavily: { async search() { return { answer: "Local roofer", images: ["https://example.com/roof.jpg"], results: [] }; } },
    pexels: { async search() { return { photos: [{ src: { large: "https://images.example/roof.jpg" } }] }; } },
    sketchBrief: { async generate() { return JSON.stringify({ BUSINESS_NAME: "Acme Roofing" }); } },
    sketchHtml: { async generate() { return "<!doctype html><html><head></head><body><h1>Acme Roofing</h1><template id=\"sitesnap-category-note\">Built for roof customers.</template></body></html>"; } },
    sketchAudit: { async generate() { return "<!doctype html><html><head></head><body><h1>Acme Roofing</h1><template id=\"sitesnap-category-note\">Built for roof customers.</template></body></html>"; } },
    vercelDelivery: {
      async deployHtml(html) { calls.deployments.push(html); return { id: "dep_1", url: "preview.vercel.app" }; },
      async waitUntilReady() { return { readyState: "READY" }; }
    },
    mail: { async send(message) { calls.mail.push(message); } },
    telegram: { async send(message) { calls.telegram.push(message); } },
    ...overrides
  };
}

test("04 test mode deploys and emails only the approved inbox without Airtable writes", async () => {
  const deps = dependencies();
  const result = await runFirstSketch("recABCDEFGHIJKLMN", deps, { testMode: true });
  assert.equal(result.recipient, "levy.dave.1@gmail.com");
  assert.equal(result.airtableUpdated, false);
  assert.equal(deps.calls.updates.length, 0);
  assert.equal(deps.calls.telegram.length, 0);
  assert.equal(deps.calls.mail.length, 1);
  assert.equal(deps.calls.mail[0].to, "levy.dave.1@gmail.com");
  assert.match(deps.calls.mail[0].subject, /^\[SiteSnap 04 Test\]/);
  assert.match(deps.calls.deployments[0], /sitesnap-open-tracker/);
  assert.match(deps.calls.deployments[0], /data-sitesnap-test="true"/);
  const trackerMatch = deps.calls.deployments[0].match(/e=(\d+),t="([a-f0-9]+)"/);
  assert.ok(trackerMatch);
  assert.equal(verifyTestOpenToken({
    secret: process.env.LOCAL_TELEGRAM_RELAY_SECRET,
    recordId: "recABCDEFGHIJKLMN",
    businessName: "Acme Roofing",
    expiresAt: Number(trackerMatch[1]),
    token: trackerMatch[2]
  }), true);
  assert.match(deps.calls.deployments[0], /id="contact"/);
  assert.match(deps.calls.deployments[0], /Why this sketch/);
  assert.match(deps.calls.deployments[0], /id="finalize-section"/);
  assert.match(deps.calls.deployments[0], /tel:2125550199/);
  assert.doesNotMatch(deps.calls.deployments[0], /tel:\+1/);
  assert.match(deps.calls.mail[0].html, /finalize\?record_id=recABCDEFGHIJKLMN/);
});

test("04 never publishes the internal test recipient as business contact data", async () => {
  const deps = dependencies();
  deps.airtable.getRecordFromTable = async () => ({ id: "recNOPQRSTUVWXYZ1", fields: {
    "Business Name": "Acme Roofing", Category: "Roofing", Phone: "+1 (212) 555-0199",
    Address: "1 Main St", City: "New York", State: "NY", Email: "levy.dave.1@gmail.com"
  } });
  deps.sketchHtml.generate = async () => '<!doctype html><html><head></head><body><img alt="Acme logo" class="w-9 h-9 rounded-full object-cover"><a href="mailto:levy.dave.1@gmail.com">levy.dave.1@gmail.com</a><template id="sitesnap-category-note">Built for roof customers.</template></body></html>';
  deps.sketchAudit.generate = deps.sketchHtml.generate;
  await runFirstSketch("recABCDEFGHIJKLMN", deps, { testMode: true });
  assert.doesNotMatch(deps.calls.deployments[0], /levy\.dave\.1@gmail\.com/);
  assert.doesNotMatch(deps.calls.deployments[0], /rounded-full object-cover/);
  assert.match(deps.calls.deployments[0], /sitesnap-brand-logo object-contain/);
});

test("04 live mode mirrors the Make fields and notifies after deployment", async () => {
  const deps = dependencies();
  const result = await runFirstSketch("recABCDEFGHIJKLMN", deps);
  assert.equal(result.airtableUpdated, true);
  assert.equal(deps.calls.updates.length, 1);
  const update = deps.calls.updates[0].fields;
  assert.equal(update[config.firstSketch.fields.customerEmail], "customer@example.com");
  assert.equal(update[config.firstSketch.fields.draftSiteUrl], "preview.vercel.app");
  assert.match(update[config.firstSketch.fields.htmlTake1], /"index.html"/);
  assert.equal(deps.calls.mail[0].to, "customer@example.com");
  assert.equal(deps.calls.telegram.length, 0);
  assert.match(deps.calls.deployments[0], /sitesnap-open-tracker/);
});
