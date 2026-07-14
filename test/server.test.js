import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../server/config.js";
import {
  availabilityFromCloudflare,
  domainAvailability,
  domainRegistration,
  existingDomain
} from "../server/handlers.js";
import { isAllowedOrigin } from "../server/vercel.js";

test("07 applies the original Make price and tier policy", async () => {
  const calls = [];
  const cloudflare = {
    async checkDomains(domains) {
      calls.push(domains);
      return [
        { name: "example.com", registrable: true, tier: "standard", pricing: { registration_cost: "10", renewal_cost: "11" } },
        { name: "getexample.com" }
      ];
    }
  };
  assert.deepEqual(
    await domainAvailability({ domains: ["Example.com", "getexample.com"] }, { cloudflare, config }),
    { available: true, alternatives: ["getexample.com"] }
  );
  assert.deepEqual(calls, [["example.com", "getexample.com"]]);
});

test("07 rejects premium domains", () => {
  assert.deepEqual(
    availabilityFromCloudflare([
      { name: "premium.com", registrable: true, tier: "premium", pricing: { registration_cost: 1, renewal_cost: 1 } }
    ], config.cloudflare),
    { available: false, alternatives: [] }
  );
});

test("07.5 maps the exact Airtable fields from the blueprint", async () => {
  const calls = [];
  const airtable = { async updateRecord(recordId, fields) { calls.push({ recordId, fields }); } };
  const result = await domainRegistration({
    record_id: "recIoxgm0vtZ9DmGv",
    selected_domain: "example.com",
    registrant_full_name: "Migration Test",
    registrant_email: "migration@example.com",
    registrant_phone: "+1.2125550199",
    business_name: "Migration LLC",
    registrant_address: "1 Test Street",
    registrant_city: "New York",
    registrant_state: "NY",
    registrant_zip: "10001",
    registrant_country: "US",
    consent: true
  }, { airtable, config });

  assert.deepEqual(result, { success: true });
  assert.equal(calls[0].fields.fldT7f1UgIPhyN7SP, "example.com");
  assert.equal(calls[0].fields.fld4NjCjsVzyHIlgE, "US");
  assert.equal(calls[0].fields.fldstbxVm4fdgSYkH, "not yes");
});

test("09 updates only the existing-domain field", async () => {
  const calls = [];
  const airtable = { async updateRecord(recordId, fields) { calls.push({ recordId, fields }); } };
  assert.deepEqual(
    await existingDomain({ record_id: "recIoxgm0vtZ9DmGv", domain: "https://www.Example.com/path" }, { airtable, config }),
    { success: true }
  );
  assert.deepEqual(calls, [{ recordId: "recIoxgm0vtZ9DmGv", fields: { fldvynrxwT7lCptbK: "example.com" } }]);
});

test("Preview deployments accept their own same-origin form submissions", () => {
  assert.equal(isAllowedOrigin({ headers: {
    origin: "https://project-et4ws-git-make-migration.vercel.app",
    host: "project-et4ws-git-make-migration.vercel.app",
    "x-forwarded-proto": "https"
  } }), true);
  assert.equal(isAllowedOrigin({ headers: {
    origin: "https://attacker.example",
    host: "trysitesnap.com",
    "x-forwarded-proto": "https"
  } }), false);
});
