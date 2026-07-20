function upstreamError(service, status, details = "") {
  const error = new Error(`${service} request failed (${status})${details ? `: ${details}` : ""}`);
  error.code = `${service.toUpperCase()}_UPSTREAM_ERROR`;
  error.status = 502;
  error.upstreamStatus = status;
  error.upstreamDetails = details;
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
    async getRecordFromTable(targetTableId, recordId) {
      const response = await fetchImpl(
        `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(targetTableId)}/${encodeURIComponent(recordId)}`,
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
    async listRecords(targetTableId, options = {}) {
      const records = [];
      let offset = "";
      do {
        const url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(targetTableId)}`);
        url.searchParams.set("pageSize", String(Math.min(100, Math.max(1, options.pageSize || 100))));
        if (options.returnFieldsByFieldId) url.searchParams.set("returnFieldsByFieldId", "true");
        if (options.filterByFormula) url.searchParams.set("filterByFormula", options.filterByFormula);
        for (const field of options.fields || []) url.searchParams.append("fields[]", field);
        for (const [index, sort] of (options.sort || []).entries()) {
          url.searchParams.set(`sort[${index}][field]`, sort.field);
          url.searchParams.set(`sort[${index}][direction]`, sort.direction || "asc");
        }
        if (offset) url.searchParams.set("offset", offset);
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs)
        });
        const payload = await readJson(response);
        if (!response.ok) {
          throw upstreamError("airtable", response.status, payload.error?.message || payload.error?.type || payload.raw || "");
        }
        records.push(...(Array.isArray(payload.records) ? payload.records : []));
        offset = payload.offset || "";
        if (options.maxRecords && records.length >= options.maxRecords) break;
      } while (offset);
      return options.maxRecords ? records.slice(0, options.maxRecords) : records;
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
    },
    async createRecord(targetTableId, fields) {
      const response = await fetchImpl(
        `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(targetTableId)}`,
        {
          method: "POST",
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

function firstOutscraperPlace(payload) {
  let data = payload?.data ?? payload;
  while (Array.isArray(data) && data.length === 1 && Array.isArray(data[0])) data = data[0];
  if (Array.isArray(data)) return data[0] || null;
  return data && typeof data === "object" && !data.error ? data : null;
}

export function createOutscraperClient({ apiKey, endpoint, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("OUTSCRAPER_API_KEY is not configured");
  return {
    async searchPlace({ query, limit = 1, language = "en", region = "US" }) {
      const url = new URL(endpoint);
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("language", language);
      url.searchParams.set("region", region);
      url.searchParams.set("async", "false");
      const response = await fetchImpl(url, {
        headers: { "X-API-KEY": apiKey },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw upstreamError(
          "outscraper",
          response.status,
          payload.errorMessage || payload.error?.message || payload.error || payload.raw || ""
        );
      }
      return firstOutscraperPlace(payload);
    }
  };
}

function modelJson(text, service) {
  const normalized = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized);
  } catch {
    throw upstreamError(service, 200, "model returned invalid JSON");
  }
}

async function retryingJson(service, url, options, { timeoutMs, fetchImpl, attempts = 4 }) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const payload = await readJson(response);
      if (response.ok) return payload;
      const details = payload.error?.message || payload.message || payload.error || payload.raw || "";
      if (response.status !== 429 && response.status < 500) {
        throw upstreamError(service, response.status, details);
      }
      lastError = upstreamError(service, response.status, details);
    } catch (error) {
      lastError = error;
      if (error.upstreamStatus && error.upstreamStatus !== 429 && error.upstreamStatus < 500) throw error;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
    }
  }
  throw lastError;
}

export function createGeminiClient({ apiKey, model, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return {
    async analyze({ system, user }) {
      const payload = await retryingJson("gemini", endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
        })
      }, { timeoutMs, fetchImpl });
      const output = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
      return modelJson(output, "gemini");
    }
  };
}

export function createClaudeClient({ apiKey, model, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  return {
    async writeEmail({ system, user }) {
      const payload = await retryingJson("claude", "https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey
        },
        body: JSON.stringify({
          model,
          max_tokens: 1000,
          temperature: 0.8,
          system,
          messages: [{ role: "user", content: user }],
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: { subject: { type: "string" }, body: { type: "string" } },
                required: ["subject", "body"],
                additionalProperties: false
              }
            }
          }
        })
      }, { timeoutMs, fetchImpl });
      const output = payload.content?.filter((part) => part.type === "text").map((part) => part.text || "").join("") || "";
      return modelJson(output, "claude");
    }
  };
}

export function createClaudeTextClient({ apiKey, model, timeoutMs, attempts = 3, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  return {
    async generate({ system, user, maxTokens = 10000, temperature = 0.4 }) {
      const payload = await retryingJson("claude", "https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: [{ role: "user", content: user }]
        })
      }, { timeoutMs, fetchImpl, attempts });
      return payload.content?.filter((part) => part.type === "text").map((part) => part.text || "").join("") || "";
    }
  };
}

export function createGeminiTextClient({ apiKey, model, timeoutMs, attempts = 4, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return {
    async generate({ system, user, maxTokens = 10000, temperature = 0.3, json = false }) {
      const payload = await retryingJson("gemini", endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            ...(json ? { responseMimeType: "application/json" } : {})
          }
        })
      }, { timeoutMs, fetchImpl, attempts });
      return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    }
  };
}

export function createTavilyClient({ apiKey, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("TAVILY_API_KEY is not configured");
  return {
    async search(query) {
      const { payload } = await requestJson("tavily", "https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "advanced",
          max_results: 10,
          include_images: true,
          include_answer: true,
          include_raw_content: true
        }),
        signal: AbortSignal.timeout(timeoutMs)
      }, { fetchImpl });
      return payload;
    }
  };
}

export function createPexelsClient({ apiKey, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("PEXELS_API_KEY is not configured");
  return {
    async search(query, page = 1) {
      const url = new URL("https://api.pexels.com/v1/search");
      url.searchParams.set("query", query);
      url.searchParams.set("per_page", "15");
      url.searchParams.set("page", String(page));
      url.searchParams.set("orientation", "landscape");
      const { payload } = await requestJson("pexels", url, {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(timeoutMs)
      }, { fetchImpl });
      return payload;
    }
  };
}

export function createInstantlyClient({ apiKey, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("INSTANTLY_API_KEY is not configured");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  return {
    async createLead(lead) {
      return retryingJson("instantly", "https://api.instantly.ai/api/v2/leads", {
        method: "POST",
        headers,
        body: JSON.stringify(lead)
      }, { timeoutMs, fetchImpl });
    },
    async listLeads(query = {}) {
      return retryingJson("instantly", "https://api.instantly.ai/api/v2/leads/list", {
        method: "POST",
        headers,
        body: JSON.stringify(query)
      }, { timeoutMs, fetchImpl });
    }
  };
}

export function createVercelDeliveryClient({ projectId, teamId, token, timeoutMs, fetchImpl = fetch, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
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
        await sleepImpl(intervalMs);
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
    async assignAlias(deploymentId, domain, { attempts = 8, intervalMs = 2000 } = {}) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const { payload } = await call(
            `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases?${query}`,
            "POST",
            { alias: domain }
          );
          return payload;
        } catch (error) {
          const certificatePending = error.upstreamStatus === 400 && /missing (?:an? )?ssl certificate/i.test(error.upstreamDetails || "");
          if (!certificatePending || attempt === attempts - 1) throw error;
          await sleepImpl(intervalMs);
        }
      }
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

