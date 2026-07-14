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

async function requestJson(service, url, options, { allow = [], fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, options);
  const payload = await readJson(response);
  if (!response.ok && !allow.includes(response.status)) {
    throw upstreamError(
      service,
      response.status,
      payload.errors?.[0]?.message || payload.error?.message || payload.error || payload.raw || ""
    );
  }
  return { status: response.status, payload };
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
    },
    async getRegistration(domain) {
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/registrar/registrations/${encodeURIComponent(domain)}`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      if (response.status === 404) return null;
      const payload = await readJson(response);
      if (!response.ok || payload.success === false) {
        throw upstreamError("cloudflare", response.status, payload.errors?.[0]?.message || payload.raw || "");
      }
      return payload.result || null;
    },
    async registerDomain(registration) {
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/registrar/registrations`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
            Prefer: "respond-async"
          },
          body: JSON.stringify(registration),
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      const payload = await readJson(response);
      if (![201, 202].includes(response.status) || payload.success === false) {
        throw upstreamError("cloudflare", response.status, payload.errors?.[0]?.message || payload.raw || "");
      }
      return { status: response.status, data: payload.result || {} };
    }
  };
}

export function createAirtableClient({ baseId, tableId, accessToken, timeoutMs, fetchImpl = fetch }) {
  if (!accessToken) throw new Error("AIRTABLE_ACCESS_TOKEN is not configured");
  return {
    async getRecord(recordId) {
      const response = await fetchImpl(
        `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      const payload = await readJson(response);
      if (!response.ok) {
        throw upstreamError("airtable", response.status, payload.error?.message || payload.error?.type || payload.raw || "");
      }
      return payload;
    },
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

export function createVercelDeliveryClient({ projectId, teamId, token, timeoutMs, fetchImpl = fetch }) {
  if (!token) throw new Error("VERCEL_DELIVERY_TOKEN is not configured");
  const query = `teamId=${encodeURIComponent(teamId)}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function call(path, method, body, allow = []) {
    const response = await fetchImpl(`https://api.vercel.com${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await readJson(response);
    if (!response.ok && !allow.includes(response.status)) {
      throw upstreamError("vercel", response.status, payload.error?.message || payload.error?.code || payload.raw || "");
    }
    return { status: response.status, payload };
  }

  return {
    async deployHtml(html, name = "corp-preview") {
      const { payload } = await call(
        `/v13/deployments?projectId=${encodeURIComponent(projectId)}&${query}&skipAutoDetectionConfirmation=1`,
        "POST",
        { name, files: [{ file: "index.html", data: html }], projectSettings: { framework: null } }
      );
      return payload;
    },
    async getDeployment(deploymentId) {
      const { payload } = await call(
        `/v13/deployments/${encodeURIComponent(deploymentId)}?${query}`,
        "GET"
      );
      return payload;
    },
    async waitUntilReady(deploymentId, { attempts = 30, intervalMs = 1000 } = {}) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const deployment = await this.getDeployment(deploymentId);
        if (deployment.readyState === "READY") return deployment;
        if (["ERROR", "CANCELED"].includes(deployment.readyState)) {
          throw new Error(`Vercel deployment ended in ${deployment.readyState}`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Error("Vercel deployment did not become ready in time");
    },
    async addProjectDomain(domain) {
      return call(
        `/v10/projects/${encodeURIComponent(projectId)}/domains?${query}`,
        "POST",
        { name: domain },
        [409]
      );
    },
    async assignAlias(deploymentId, domain) {
      const { payload } = await call(
        `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases?${query}`,
        "POST",
        { alias: domain }
      );
      return payload;
    }
  };
}

export function createTelegramClient({ botToken, chatId, timeoutMs, fetchImpl = fetch }) {
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return {
    async send(text) {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const payload = await readJson(response);
      if (!response.ok || payload.ok === false) {
        throw upstreamError("telegram", response.status, payload.description || payload.raw || "");
      }
      return payload.result;
    }
  };
}

export function createMailRelayClient({ url, secret, from, timeoutMs, fetchImpl = fetch }) {
  if (!url || !secret) throw new Error("MAIL_RELAY_URL and MAIL_RELAY_SECRET are not configured");
  return {
    async send({ to, subject, html }) {
      const { payload } = await requestJson("mail", url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, from, to, subject, html }),
        signal: AbortSignal.timeout(timeoutMs)
      }, { fetchImpl });
      if (payload.success === false) throw upstreamError("mail", 500, payload.error || "relay rejected request");
      return payload;
    }
  };
}

