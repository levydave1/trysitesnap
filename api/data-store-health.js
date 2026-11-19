import { checkDataStore } from "../server/data-store-health.js";
import { createRuntimeDependencies } from "../server/runtime.js";

export default async function dataStoreHealthHandler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }

  try {
    const result = await checkDataStore(createRuntimeDependencies({ airtable: true }));
    return response.status(200).json(result);
  } catch (error) {
    console.error(JSON.stringify({
      event: "data_store_health_failed",
      code: error.code || "DATA_STORE_UNAVAILABLE",
      message: String(error.message || "").slice(0, 200)
    }));
    return response.status(503).json({
      success: false,
      code: "DATA_STORE_UNAVAILABLE"
    });
  }
}
