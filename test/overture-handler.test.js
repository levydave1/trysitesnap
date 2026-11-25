import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyGitHubOidcToken } from "../server/overture-handler.js";

function tokenFor(claimOverrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://token.actions.githubusercontent.com",
    aud: "sitesnap-overture",
    repository: "levydave1/trysitesnap",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    workflow_ref: "levydave1/trysitesnap/.github/workflows/overture-leads.yml@refs/heads/main",
    nbf: 1_795_500_000,
    exp: 1_795_600_000,
    ...claimOverrides
  })).toString("base64url");
  const content = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url");
  return { token: `${content}.${signature}`, jwk };
}

function jwksFetch(jwk) {
  return async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("Overture accepts a signed short-lived identity only from its GitHub workflow", async () => {
  const valid = tokenFor();
  assert.equal(await verifyGitHubOidcToken(valid.token, {
    now: 1_795_550_000_000,
    fetchImpl: jwksFetch(valid.jwk)
  }), true);

  const wrongRepository = tokenFor({ repository: "someone/else" });
  assert.equal(await verifyGitHubOidcToken(wrongRepository.token, {
    now: 1_795_550_000_000,
    fetchImpl: jwksFetch(wrongRepository.jwk)
  }), false);

  const expired = tokenFor({ exp: 1_795_500_001 });
  assert.equal(await verifyGitHubOidcToken(expired.token, {
    now: 1_795_550_000_000,
    fetchImpl: jwksFetch(expired.jwk)
  }), false);

  const scheduled = tokenFor({ event_name: "schedule" });
  assert.equal(await verifyGitHubOidcToken(scheduled.token, {
    now: 1_795_550_000_000,
    fetchImpl: jwksFetch(scheduled.jwk)
  }), true);
});
