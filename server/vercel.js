import { createAirtableClient, createCloudflareClient } from "./clients.js";
import { config } from "./config.js";
import { withOptionalAirtableMirror } from "./airtable-mirror.js";

function requestOrigin(request) {
  const protocol = String(request.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  return host ? `${protocol}://${host}` : "";
}

export function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || config.allowedOrigins.includes(origin) || origin === requestOrigin(request);
}

function applyHeaders(request, response) {
  const origin = request.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function bodySize(request) {
  const raw = JSON.stringify(request.body || {});
  return Buffer.byteLength(raw);
}

export function createVercelHandler({ method, action, needsCloudflare = false, needsAirtable = false }) {
  return async function handler(request, response) {
    applyHeaders(request, response);
    const origin = request.headers.origin;

    if (!isAllowedOrigin(request)) {
      return response.status(403).json({ success: false, code: "ORIGIN_NOT_ALLOWED" });
    }
    if (request.method === "OPTIONS") return response.status(204).end();
    if (!method.includes(request.method)) {
      response.setHeader("Allow", method.join(", "));
      return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
    }
    if (bodySize(request) > config.bodyBytes) {
      return response.status(413).json({ success: false, code: "BODY_TOO_LARGE" });
    }

    try {
      const dependencies = { config };
      if (needsCloudflare) {
        dependencies.cloudflare = createCloudflareClient({
          accountId: config.cloudflare.accountId,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
          timeoutMs: config.upstreamTimeoutMs
        });
      }
      if (needsAirtable) {
        const airtable = createAirtableClient({
          baseId: config.airtable.baseId,
          tableId: config.airtable.tableId,
          accessToken: process.env.AIRTABLE_ACCESS_TOKEN,
          timeoutMs: config.upstreamTimeoutMs
        });
        dependencies.airtable = withOptionalAirtableMirror(airtable, {
          defaultTableId: config.airtable.tableId
        });
      }

      const input = request.method === "GET" ? request.query : request.body;
      return response.status(200).json(await action(input, dependencies));
    } catch (error) {
      const status = Number(error.status) || 500;
      console.error(JSON.stringify({
        event: "webhook_failed",
        path: request.url,
        method: request.method,
        status,
        code: error.code || "INTERNAL_ERROR"
      }));
      return response.status(status).json({
        success: false,
        code: error.code || "INTERNAL_ERROR",
        message: status >= 500 ? "Upstream service error" : error.message
      });
    }
  };
}
