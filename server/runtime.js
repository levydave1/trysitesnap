import {
  createAirtableClient,
  createClaudeClient,
  createCloudflareClient,
  createGeminiClient,
  createInstantlyClient,
  createMailRelayClient,
  createOutscraperClient,
  createTelegramClient,
  createVercelDeliveryClient
} from "./clients.js";
import { config } from "./config.js";

export function createRuntimeDependencies(needs = {}) {
  const dependencies = { config };
  if (needs.airtable) {
    dependencies.airtable = createAirtableClient({
      baseId: config.airtable.baseId,
      tableId: config.airtable.tableId,
      accessToken: process.env.AIRTABLE_ACCESS_TOKEN,
      timeoutMs: config.upstreamTimeoutMs
    });
  }
  if (needs.cloudflare) {
    dependencies.cloudflare = createCloudflareClient({
      accountId: config.cloudflare.accountId,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      timeoutMs: config.upstreamTimeoutMs
    });
  }
  if (needs.outscraper) {
    dependencies.outscraper = createOutscraperClient({
      apiKey: process.env.OUTSCRAPER_API_KEY,
      endpoint: config.outscraper.endpoint,
      timeoutMs: config.outscraper.timeoutMs
    });
  }
  if (needs.emailExport) {
    if (needs.emailFlow === "legacy") {
      dependencies.gemini = createGeminiClient({
        apiKey: process.env.GEMINI_API_KEY,
        model: config.emailExport.geminiModel,
        timeoutMs: 45000
      });
    }
    dependencies.claude = createClaudeClient({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: config.emailExport.claudeModel,
      timeoutMs: 60000
    });
    dependencies.instantly = createInstantlyClient({
      apiKey: process.env.INSTANTLY_API_KEY,
      timeoutMs: 30000
    });
  }
  if (needs.vercelDelivery) {
    dependencies.vercelDelivery = createVercelDeliveryClient({
      projectId: config.vercelDelivery.projectId,
      teamId: config.vercelDelivery.teamId,
      token: process.env.VERCEL_DELIVERY_TOKEN,
      timeoutMs: config.upstreamTimeoutMs
    });
  }
  if (needs.notifications) {
    dependencies.telegram = process.env.TELEGRAM_BOT_TOKEN
      ? createTelegramClient({
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          chatId: config.notifications.telegramChatId,
          timeoutMs: config.upstreamTimeoutMs
        })
      : null;
    dependencies.mail = process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_SECRET
      ? createMailRelayClient({
          url: process.env.MAIL_RELAY_URL,
          secret: process.env.MAIL_RELAY_SECRET,
          from: config.notifications.mailFrom,
          timeoutMs: config.upstreamTimeoutMs
        })
      : null;
  }
  return dependencies;
}
