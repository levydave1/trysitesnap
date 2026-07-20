import assert from "node:assert/strict";
import test from "node:test";
import { processTelegramRelay } from "../server/telegram-relay.js";

test("Telegram relay rejects a wrong bearer token", async () => {
  await assert.rejects(
    processTelegramRelay({
      authorization: "Bearer wrong",
      relaySecret: "correct",
      body: {},
      telegram: { send: async () => ({}) }
    }),
    (error) => error.status === 401 && error.code === "UNAUTHORIZED"
  );
});

test("Telegram relay validates and forwards an allowed scenario", async () => {
  let delivered = "";
  const result = await processTelegramRelay({
    authorization: "Bearer correct",
    relaySecret: "correct",
    body: { eventKey: "04:rec:hash", scenario: "04", recordId: "rec", message: "test message" },
    telegram: { send: async (message) => { delivered = message; return { message_id: 123 }; } }
  });
  assert.equal(delivered, "test message");
  assert.deepEqual(result, {
    success: true,
    eventKey: "04:rec:hash",
    scenario: "04",
    telegramMessageId: 123
  });
});

test("Telegram relay rejects scenarios outside 04-06", async () => {
  await assert.rejects(
    processTelegramRelay({
      authorization: "Bearer correct",
      relaySecret: "correct",
      body: { eventKey: "bad", scenario: "07", recordId: "rec", message: "test" },
      telegram: { send: async () => ({}) }
    }),
    (error) => error.status === 400 && error.code === "INVALID_SCENARIO"
  );
});
