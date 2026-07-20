import { timingSafeEqual } from "node:crypto";

const allowedScenarios = new Set(["04", "05", "06"]);

function unauthorized() {
  const error = new Error("Unauthorized");
  error.status = 401;
  error.code = "UNAUTHORIZED";
  return error;
}

function invalid(code) {
  const error = new Error("Invalid relay request");
  error.status = 400;
  error.code = code;
  return error;
}

function validSecret(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function processTelegramRelay({ authorization, body, relaySecret, telegram }) {
  const match = String(authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match || !validSecret(match[1], relaySecret)) throw unauthorized();
  if (!telegram) {
    const error = new Error("Telegram is not configured");
    error.status = 503;
    error.code = "TELEGRAM_NOT_CONFIGURED";
    throw error;
  }

  const eventKey = String(body?.eventKey || "").trim();
  const scenario = String(body?.scenario || "").trim();
  const recordId = String(body?.recordId || "").trim();
  const message = String(body?.message || "").trim();
  if (!eventKey || eventKey.length > 200) throw invalid("INVALID_EVENT_KEY");
  if (!allowedScenarios.has(scenario)) throw invalid("INVALID_SCENARIO");
  if (!recordId || recordId.length > 200) throw invalid("INVALID_RECORD_ID");
  if (!message || message.length > 4096) throw invalid("INVALID_MESSAGE");

  const sent = await telegram.send(message);
  return {
    success: true,
    eventKey,
    scenario,
    telegramMessageId: sent?.message_id || null
  };
}
