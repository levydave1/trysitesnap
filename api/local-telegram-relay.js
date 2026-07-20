import { createRuntimeDependencies } from "../server/runtime.js";
import { processTelegramRelay } from "../server/telegram-relay.js";

function applyHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

export default async function handler(request, response) {
  applyHeaders(response);
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }

  try {
    const { telegram } = createRuntimeDependencies({ notifications: true });
    const result = await processTelegramRelay({
      authorization: request.headers.authorization,
      body: request.body,
      relaySecret: process.env.AIRTABLE_ACCESS_TOKEN,
      telegram
    });
    return response.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    console.error(JSON.stringify({
      event: "local_telegram_relay_failed",
      status,
      code: error.code || "TELEGRAM_RELAY_FAILED",
      message: String(error.message || "").slice(0, 200)
    }));
    return response.status(status).json({
      success: false,
      code: error.code || "TELEGRAM_RELAY_FAILED"
    });
  }
}
