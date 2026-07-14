import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createCloudflareClient, createVercelDeliveryClient } from "../server/clients.js";
import { config } from "../server/config.js";
import { verifyStripeEvent } from "../server/stripe-webhook.js";
import { prepareDeliveredHtml } from "../server/templates.js";
import { processDomainPurchase, processSiteDelivery, recordSketchOpened } from "../server/workflows.js";

function stripeEvent(overrides = {}) {
  return {
    id: "evt_migration_test",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_test_migration",
      payment_status: "paid",
      client_reference_id: "recIoxgm0vtZ9DmGv__example_dot_com",
      payment_link: config.stripe.paymentLinks.newDomain,
      customer_details: { email: "customer@example.com" },
      ...overrides
    } }
  };
}

test("Stripe signatures are verified against the untouched raw body", () => {
  const raw = Buffer.from(JSON.stringify(stripeEvent()));
  const timestamp = 1_700_000_000;
  const secret = "whsec_migration_test";
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  assert.equal(verifyStripeEvent(raw, `t=${timestamp},v1=${signature}`, secret, 300, timestamp * 1000).id, "evt_migration_test");
  assert.throws(() => verifyStripeEvent(Buffer.from(`${raw} `), `t=${timestamp},v1=${signature}`, secret, 300, timestamp * 1000), /Invalid Stripe signature/);
  assert.throws(() => verifyStripeEvent(raw, `t=${timestamp},v1=${signature}`, secret, 300, (timestamp + 301) * 1000), /Expired Stripe signature/);
});

test("10 prepares one clean HTML document with the new scenario 12 tracker", () => {
  const input = JSON.stringify({ files: [{ file: "index.html", data: "<!doctype html><html><body><h1>Hello</h1><!-- SITESNAP_WRAPPER_START -->remove<!-- SITESNAP_WRAPPER_END --></body></html>" }] });
  const html = prepareDeliveredHtml(input, "recIoxgm0vtZ9DmGv");
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.doesNotMatch(html, /remove/);
  assert.match(html, /api\/3b7f5316669d40c19e243c38f67b52ec/);
  assert.doesNotMatch(html, /sketch-opened/);
  assert.equal((html.match(/<\/html>/g) || []).length, 1);
});

test("08 safe test performs Cloudflare checks without purchasing or writing", async () => {
  const writes = [];
  let registered = false;
  const result = await processDomainPurchase(stripeEvent(), {
    config,
    airtable: {
      async getRecord() { return { fields: { "Business Name": "Migration Test" } }; },
      async updateRecord(...args) { writes.push(args); }
    },
    cloudflare: {
      async getRegistration() { return null; },
      async checkDomains() { return [{ registrable: true, tier: "standard", pricing: { registration_cost: "9.50", renewal_cost: "10.50" } }]; },
      async registerDomain() { registered = true; }
    },
    mail: null,
    telegram: null
  }, { testMode: true });
  assert.equal(result.wouldPurchase, true);
  assert.equal(registered, false);
  assert.deepEqual(writes, []);
});

test("08 blocks purchase when either registration or renewal exceeds $12", async () => {
  const writes = [];
  let registered = false;
  const result = await processDomainPurchase(stripeEvent(), {
    config,
    airtable: {
      async getRecord() { return { fields: { "Business Name": "Migration Test", "Domain Registration Email": "test@example.com" } }; },
      async updateRecord(id, fields) { writes.push({ id, fields }); }
    },
    cloudflare: {
      async getRegistration() { return null; },
      async checkDomains() { return [{ registrable: true, tier: "standard", pricing: { registration_cost: "11", renewal_cost: "13" } }]; },
      async registerDomain() { registered = true; }
    },
    mail: { async send() {} },
    telegram: { async send() {} }
  });
  assert.equal(result.status, "Manual Review - Domain Check Failed");
  assert.equal(registered, false);
  assert.equal(writes[0].fields[config.airtable.fields.status], "Manual Review - Domain Check Failed");
});

test("08 locks the Airtable record and starts one asynchronous Cloudflare registration", async () => {
  const writes = [];
  let registrations = 0;
  const fields = {
    "Business Name": "Migration Test",
    "Domain Registration Email": "test@example.com",
    "Domain Registration Phone": "+1.2125550199",
    "Domain Registration Full Name": "Migration Test",
    "Domain Registration Business Name": "Migration LLC",
    "Domain Registration Address": "1 Test Street",
    "Domain Registration City": "New York",
    "Domain Registration State": "NY",
    "Domain Registration ZIP": "10001",
    "Domain Registration Country": "US"
  };
  const airtable = {
    async getRecord() { return { fields }; },
    async updateRecord(id, update) {
      writes.push({ id, update });
      if (update[config.airtable.fields.notes]) fields.Notes = update[config.airtable.fields.notes];
    }
  };
  const result = await processDomainPurchase(stripeEvent(), {
    config,
    airtable,
    cloudflare: {
      async getRegistration() { return null; },
      async checkDomains() { return [{ registrable: true, tier: "standard", pricing: { registration_cost: "10", renewal_cost: "11" } }]; },
      async registerDomain(registration) {
        registrations += 1;
        assert.equal(registration.domain_name, "example.com");
        return { status: 202, data: { state: "in_progress" } };
      }
    },
    mail: { async send() {} },
    telegram: { async send() {} }
  });
  assert.equal(registrations, 1);
  assert.equal(result.status, "Domain Purchase Processing");
  assert.match(writes[0].update[config.airtable.fields.notes], /^domain-purchase:evt_migration_test:/);
  assert.equal(writes.at(-1).update[config.airtable.fields.paymentStatus], "paid");
});

test("Cloudflare registration client requests immediate async processing", async () => {
  const calls = [];
  const client = createCloudflareClient({ accountId: "acct", apiToken: "secret", timeoutMs: 1000, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ success: true, result: { state: "in_progress" } }), { status: 202 });
  } });
  const result = await client.registerDomain({ domain_name: "example.com" });
  assert.equal(result.status, 202);
  assert.equal(calls[0].options.headers.Prefer, "respond-async");
});

test("Vercel delivery client targets the dedicated project for deploy, domain and alias", async () => {
  const calls = [];
  const client = createVercelDeliveryClient({ projectId: "prj_test", teamId: "team_test", token: "secret", timeoutMs: 1000, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const body = url.includes("/v13/deployments") ? { id: "dpl_test" } : url.includes("/aliases") ? { alias: "demo.trysitesnap.com" } : { name: "demo.trysitesnap.com" };
    return new Response(JSON.stringify(body), { status: 200 });
  } });
  assert.equal((await client.deployHtml("<html></html>")).id, "dpl_test");
  assert.equal((await client.getDeployment("dpl_test")).id, "dpl_test");
  await client.addProjectDomain("demo.trysitesnap.com");
  assert.equal((await client.assignAlias("dpl_test", "demo.trysitesnap.com")).alias, "demo.trysitesnap.com");
  assert.match(calls[0].url, /projectId=prj_test/);
  assert.match(calls[1].url, /\/v13\/deployments\/dpl_test/);
  assert.match(calls[2].url, /\/v10\/projects\/prj_test\/domains/);
  assert.match(calls[3].url, /\/v2\/deployments\/dpl_test\/aliases/);
});

test("10 deploys, aliases, updates Airtable, and embeds scenario 12", async () => {
  const calls = [];
  const input = JSON.stringify({ files: [{ file: "index.html", data: "<!doctype html><html><body>Migration delivery</body></html>" }] });
  const event = stripeEvent({ client_reference_id: "recIoxgm0vtZ9DmGv", payment_link: config.stripe.paymentLinks.subdomain });
  const result = await processSiteDelivery(event, {
    config,
    airtable: {
      async getRecord() { return { fields: { "Business Name": "Migration Test", "HTML-TAKE2": input, Domain_Slug: "migration-test" } }; },
      async updateRecord(id, fields) { calls.push(["airtable", id, fields]); }
    },
    vercelDelivery: {
      async deployHtml(html) { calls.push(["deploy", html]); return { id: "dpl_test" }; },
      async waitUntilReady(id) { calls.push(["ready", id]); },
      async addProjectDomain(domain) { calls.push(["domain", domain]); },
      async assignAlias(id, domain) { calls.push(["alias", id, domain]); return { alias: domain }; }
    },
    mail: null,
    telegram: null
  }, { skipNotifications: true });
  assert.equal(result.domain, "migration-test.trysitesnap.com");
  assert.deepEqual(calls.slice(1, 4), [["ready", "dpl_test"], ["domain", "migration-test.trysitesnap.com"], ["alias", "dpl_test", "migration-test.trysitesnap.com"]]);
  assert.match(calls[0][1], /api\/3b7f5316669d40c19e243c38f67b52ec/);
  assert.doesNotMatch(calls[0][1], /sketch-opened/);
  assert.equal(calls[4][2][config.airtable.fields.generatedSiteUrl], "https://migration-test.trysitesnap.com");
});

test("12 writes the first open and suppresses later duplicate notifications", async () => {
  const writes = [];
  const messages = [];
  const airtable = {
    async getRecord() { return { fields: { "Business Name": "Migration Test" } }; },
    async updateRecord(id, fields) { writes.push({ id, fields }); }
  };
  const first = await recordSketchOpened({ record_id: "recIoxgm0vtZ9DmGv", opened_at: "2026-07-14T10:00:00Z" }, {
    config,
    airtable,
    telegram: { async send(message) { messages.push(message); } }
  });
  assert.equal(first.success, true);
  assert.equal(writes[0].fields[config.airtable.fields.sketchOpened], "2026-07-14T10:00:00.000Z");
  airtable.getRecord = async () => ({ fields: { "sketch opened": "2026-07-14T10:00:00.000Z" } });
  const duplicate = await recordSketchOpened({ record_id: "recIoxgm0vtZ9DmGv", opened_at: "2026-07-14T11:00:00Z" }, { config, airtable, telegram: { async send() { messages.push("duplicate"); } } });
  assert.equal(duplicate.duplicate, true);
  assert.equal(messages.length, 1);
});
