import { createRuntimeDependencies } from "../server/runtime.js";
import { recordSketchOpened } from "../server/workflows.js";

function headers(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
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
    return response.status(200).json(await recordSketchOpened(
      request.body,
      createRuntimeDependencies({ airtable: true, notifications: true })
    ));
  } catch (error) {
    console.error(JSON.stringify({ event: "sketch_opened_failed", message: String(error.message || "").slice(0, 300) }));
    return response.status(400).json({ success: false, code: "INVALID_REQUEST" });
  }
}
