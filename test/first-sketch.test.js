import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../server/config.js";
import { repairFirstSketchTest, runFirstSketch, verifyTestOpenToken } from "../server/first-sketch.js";

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
  assert.equal(result.auditUsed, false);
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
  assert.match(deps.calls.deployments[0], /google\.com\/maps/);
  assert.match(deps.calls.deployments[0], /google\.com\/maps/);
  assert.doesNotMatch(deps.calls.deployments[0], /<form\b/i);
  assert.match(deps.calls.deployments[0], /Why this sketch/);
  assert.match(deps.calls.deployments[0], /id="finalize-section"/);
  assert.match(deps.calls.deployments[0], /sitesnap-pattern-dots/);
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

test("04 replaces fake generated forms with a real map and separates the logo header", async () => {
  const deps = dependencies();
  const generated = '<!doctype html><html><head></head><body><header class="bg-dark"><img alt="Acme logo"></header><section id="contact"><div><h3>Request a Free Quote</h3><form onsubmit="alert(1)"><input required><button type="submit">Send</button></form></div></section></body></html>';
  deps.sketchHtml.generate = async () => generated;
  deps.sketchAudit.generate = async () => generated;
  await runFirstSketch("recABCDEFGHIJKLMN", deps, { testMode: true });
  const html = deps.calls.deployments[0];
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /onsubmit=/i);
  assert.match(html, /class="bg-dark sitesnap-brand-header"/);
  assert.match(html, /data-sitesnap-map/);
  assert.match(html, /Map for Acme Roofing/);
  assert.match(html, />Find Us<\/h3>/);
  assert.doesNotMatch(html, /Request a Free Quote/);
  assert.match(html, /footer:not\(\[data-sitesnap-footer\]\).*color:#f8fafc!important/);
});

test("04 repair mode safely republishes an existing preview without Airtable writes", async () => {
  const deps = dependencies({
    async fetchHtml() {
      return '<!doctype html><html><head></head><body><header><img alt="Acme logo"></header><section id="contact"><h3>Request a Free Quote</h3><div data-sitesnap-map><iframe src="https://www.google.com/maps?q=Acme&output=embed"></iframe></div></section><style data-sitesnap-preview>.old{}</style><script data-sitesnap-open-tracker>old()</script></body></html>';
    }
  });
  const result = await repairFirstSketchTest(deps, {
    recordId: "recABCDEFGHIJKLMN",
    sourceUrl: "https://old-preview.vercel.app"
  });
  assert.equal(result.repaired, true);
  assert.equal(result.airtableUpdated, false);
  assert.equal(deps.calls.updates.length, 0);
  assert.equal(deps.calls.mail[0].to, "levy.dave.1@gmail.com");
  assert.match(deps.calls.mail[0].subject, /^\[SiteSnap 04 Test — Corrected\]/);
  assert.doesNotMatch(deps.calls.deployments[0], /<form\b/i);
  assert.doesNotMatch(deps.calls.deployments[0], /old\(\)/);
  assert.match(deps.calls.deployments[0], /data-sitesnap-map/);
  assert.match(deps.calls.deployments[0], />Find Us<\/h3>/);
  assert.match(deps.calls.deployments[0], /sitesnap-brand-header/);
});

test("04 repairs a truncated model document once", async () => {
  const deps = dependencies();
  let auditCalls = 0;
  deps.sketchHtml.generate = async () => '<!doctype html><html><head></head><body><main>truncated';
  deps.sketchAudit.generate = async () => {
    auditCalls += 1;
    return '<!doctype html><html><head></head><body><h1>Repaired</h1></body></html>';
  };
  await runFirstSketch("recABCDEFGHIJKLMN", deps, { testMode: true });
  assert.equal(auditCalls, 1);
  assert.match(deps.calls.deployments[0], /<h1>Repaired<\/h1>/);
  assert.match(deps.calls.deployments[0], /data-sitesnap-preview/);
});

test("04 deploys a complete deterministic fallback when the repair remains truncated", async () => {
  const deps = dependencies();
  deps.sketchHtml.generate = async () => "<html><body><main>truncated";
  deps.sketchAudit.generate = async () => "<html><body><main>still truncated";
  const result = await runFirstSketch("recABCDEFGHIJKLMN", deps, { testMode: true });
  assert.equal(result.auditUsed, true);
  assert.equal(result.fallbackUsed, true);
  assert.match(deps.calls.deployments[0], /<!doctype html>/i);
  assert.match(deps.calls.deployments[0], /google\.com\/maps/);
  assert.doesNotMatch(deps.calls.deployments[0], /<form\b/i);
});

test("04 live mode mirrors the Make fields and notifies after deployment", async () => {
  const deps = dependencies();
  const result = await runFirstSketch("recABCDEFGHIJKLMN", deps);
  assert.equal(result.airtableUpdated, true);
  assert.equal(deps.calls.updates.length, 1);
  const update = deps.calls.updates[0].fields;
  assert.equal(update[config.firstSketch.fields.customerEmail], "customer@example.com");
  assert.equal(update[config.firstSketch.fields.geminiOutput], update[config.firstSketch.fields.claudeOutput]);
  assert.equal(update[config.firstSketch.fields.draftSiteUrl], "preview.vercel.app");
  assert.match(update[config.firstSketch.fields.htmlTake1], /"index.html"/);
  assert.equal(deps.calls.mail[0].to, "customer@example.com");
  assert.equal(deps.calls.telegram.length, 0);
  assert.match(deps.calls.deployments[0], /sitesnap-open-tracker/);
});

test("04 live retry returns an existing draft without regenerating or emailing", async () => {
  const deps = dependencies();
  deps.airtable.getRecord = async () => ({ id: "recABCDEFGHIJKLMN", fields: {
    "Business ID": "recNOPQRSTUVWXYZ1",
    "Business Name": "Acme Roofing",
    "Customer Email": "customer@example.com",
    "Draft Site URL": "existing-preview.vercel.app"
  } });
  const result = await runFirstSketch("recABCDEFGHIJKLMN", deps);
  assert.equal(result.duplicate, true);
  assert.equal(result.draftUrl, "https://existing-preview.vercel.app");
  assert.equal(deps.calls.deployments.length, 0);
  assert.equal(deps.calls.updates.length, 0);
  assert.equal(deps.calls.mail.length, 0);
});
