import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeClient, createGeminiClient, createInstantlyClient } from "../server/clients.js";
import { processEmailExportBatch, isLocalNoon, isValidLeadEmail } from "../server/email-export.js";
import { config } from "../server/config.js";

test("02 direct AI clients request the configured models and parse JSON", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    if (String(url).includes("googleapis")) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"hook":"specific detail","reputation":"","pain":"old site"}' }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"subject":"Quick idea","body":"Hi Sam — want to see the homepage draft?"}' }] }), { status: 200 });
  };
  const gemini = createGeminiClient({ apiKey: "gemini-secret", model: "gemini-test", timeoutMs: 1000, fetchImpl });
  const claude = createClaudeClient({ apiKey: "claude-secret", model: "claude-test", timeoutMs: 1000, fetchImpl });
  assert.equal((await gemini.analyze({ system: "system", user: "user" })).hook, "specific detail");
  assert.equal((await claude.writeEmail({ system: "system", user: "user" })).subject, "Quick idea");
  assert.match(calls[0].url, /gemini-test:generateContent/);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "gemini-secret");
  assert.equal(calls[1].body.model, "claude-test");
  assert.deepEqual(calls[1].body.output_config.format.schema.required, ["subject", "body"]);
});

test("02 Instantly client uses API v2 with bearer authentication", async () => {
  const calls = [];
  const client = createInstantlyClient({ apiKey: "instantly-secret", timeoutMs: 1000, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(String(url).endsWith("/list") ? { items: [] } : { id: "lead-test" }), { status: 200 });
  } });
  assert.equal((await client.createLead({ email: "lead@example.com" })).id, "lead-test");
  await client.listLeads({ search: "lead@example.com" });
  assert.equal(calls[0].url, "https://api.instantly.ai/api/v2/leads");
  assert.equal(calls[1].url, "https://api.instantly.ai/api/v2/leads/list");
  assert.equal(calls[0].options.headers.Authorization, "Bearer instantly-secret");
});

test("02 exports only undocumented raw leads and records the Instantly result", async () => {
  const writes = [];
  const instantPayloads = [];
  const messages = [];
  const tf = config.airtable.emailThreadFields;
  const result = await processEmailExportBatch({
    config,
    airtable: {
      async listRecords(tableId) {
        if (tableId === config.airtable.emailThreadsTableId) {
          return [{ fields: { [tf.rawBusinessRecord]: ["recAlreadyExported"], [tf.status]: "sent" } }];
        }
        return [
          { id: "recAlreadyExported", createdTime: "2026-07-01T10:00:00Z", fields: { Email: "old@example.com" } },
          { id: "recNewExportLead", createdTime: "2026-07-02T10:00:00Z", fields: {
            "First Name": "Sam",
            "Last Name": "Owner",
            "Full Name": "Sam Owner",
            "Business Name": "Migration Bakery",
            "Website Generator": "Wix",
            "About JSON": "Family bakery",
            "Reviews Count": 40,
            Rating: 4.8,
            Category: "Bakery",
            City: "New York",
            Website: "https://example.com",
            Email: "lead@example.com"
          } }
        ];
      },
      async createRecord(tableId, fields) { writes.push({ tableId, fields }); return { id: "recThreadTest" }; }
    },
    gemini: { async analyze() { return { hook: "family bakery", reputation_comment: "great reviews", platform_pain: "updates" }; } },
    claude: { async writeEmail() { return { subject: "Small homepage idea", body: "Hi Sam — I made a small homepage draft. Want to see it?" }; } },
    instantly: {
      async createLead(payload) { instantPayloads.push(payload); return { id: "lead-test-02" }; },
      async listLeads() { return { items: [] }; }
    },
    telegram: { async send(message) { messages.push(message); } }
  });
  assert.equal(result.candidates, 1);
  assert.equal(result.exported, 1);
  assert.equal(instantPayloads[0].campaign, config.emailExport.campaignId);
  assert.equal(instantPayloads[0].custom_variables.businessId, "recNewExportLead");
  assert.equal(instantPayloads[0].skip_if_in_campaign, true);
  assert.equal(writes[0].tableId, config.airtable.emailThreadsTableId);
  assert.deepEqual(writes[0].fields[tf.rawBusinessRecord], ["recNewExportLead"]);
  assert.equal(writes[0].fields[tf.instantlyLeadId], "lead-test-02");
  assert.equal(writes[0].fields[tf.status], "sent");
  assert.match(messages[0], /נשלחו: 1/);
});

test("02 ignores malformed source emails before applying the batch limit", async () => {
  const sent = [];
  const result = await processEmailExportBatch({
    config: { ...config, emailExport: { ...config.emailExport, maxRecords: 1 } },
    airtable: {
      async listRecords(tableId) {
        if (tableId === config.airtable.emailThreadsTableId) return [];
        return [
          { id: "recMalformed", createdTime: "2026-01-01T00:00:00Z", fields: { Email: "owner@example.com?subject=contact" } },
          { id: "recValid", createdTime: "2026-01-02T00:00:00Z", fields: { Email: "owner+test@example.com", "Business Name": "Valid Lead" } }
        ];
      },
      async createRecord() { return { id: "recThread" }; }
    },
    gemini: { async analyze() { return { hook: "detail" }; } },
    claude: { async writeEmail() { return { subject: "Quick idea", body: "Short email" }; } },
    instantly: {
      async createLead(payload) { sent.push(payload.email); return { id: "lead-valid" }; },
      async listLeads() { return { items: [] }; }
    },
    telegram: { async send() {} }
  });
  assert.equal(result.candidates, 1);
  assert.equal(result.exported, 1);
  assert.deepEqual(sent, ["owner+test@example.com"]);
  assert.equal(isValidLeadEmail("owner@example.com?subject=contact"), false);
  assert.equal(isValidLeadEmail("owner+test@example.com"), true);
});

test("02 local-noon gate follows Israel daylight saving time", () => {
  assert.equal(isLocalNoon(new Date("2026-07-16T09:30:00Z")), true);
  assert.equal(isLocalNoon(new Date("2026-07-16T10:30:00Z")), false);
  assert.equal(isLocalNoon(new Date("2026-12-16T10:30:00Z")), true);
  assert.equal(isLocalNoon(new Date("2026-12-16T09:30:00Z")), false);
});
