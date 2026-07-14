function upstreamError(service, status, details = "") {
  const error = new Error(`${service} request failed (${status})${details ? `: ${details}` : ""}`);
  error.code = `${service.toUpperCase()}_UPSTREAM_ERROR`;
  error.status = 502;
  return error;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export function createCloudflareClient({ accountId, apiToken, timeoutMs, fetchImpl = fetch }) {
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is not configured");
  return {
    async checkDomains(domains) {
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/registrar/domain-check`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ domains }),
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      const payload = await readJson(response);
      if (!response.ok || payload.success === false) {
        throw upstreamError(
          "cloudflare",
          response.status,
          payload.errors?.[0]?.message || payload.raw || ""
        );
      }
      return Array.isArray(payload.result?.domains) ? payload.result.domains : [];
    }
  };
}

export function createAirtableClient({ baseId, tableId, accessToken, timeoutMs, fetchImpl = fetch }) {
  if (!accessToken) throw new Error("AIRTABLE_ACCESS_TOKEN is not configured");
  return {
    async updateRecord(recordId, fields) {
      const response = await fetchImpl(
        `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ fields, typecast: false }),
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      const payload = await readJson(response);
      if (!response.ok) {
        throw upstreamError(
          "airtable",
          response.status,
          payload.error?.message || payload.error?.type || payload.raw || ""
        );
      }
      return payload;
    }
  };
}

