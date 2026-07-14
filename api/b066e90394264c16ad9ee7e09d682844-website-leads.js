import { createRuntimeDependencies } from "../server/runtime.js";
import { processWebsiteLead } from "../server/workflows.js";

function headers(response) {
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

export default async function handler(request, response) {
  headers(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, OPTIONS");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  try {
    const result = await processWebsiteLead(
      request.body,
      createRuntimeDependencies({ airtable: true, outscraper: true, notifications: true })
    );
    return response.status(201).json(result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    console.error(JSON.stringify({
      event: "website_lead_failed",
      code: error.code || "WEBSITE_LEAD_FAILED",
      message: String(error.message || "").slice(0, 300),
      upstreamStatus: error.upstreamStatus || null
    }));
    return response.status(status).json({
      success: false,
      code: error.code || (status < 500 ? "INVALID_REQUEST" : "WEBSITE_LEAD_FAILED")
    });
  }
}
