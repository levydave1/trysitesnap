import { runOutscraperWatchdog } from "../server/outscraper-watchdog.js";
import { createRuntimeDependencies } from "../server/runtime.js";

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers?.authorization === `Bearer ${secret}`;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (!authorized(request)) return response.status(401).json({ success: false, code: "UNAUTHORIZED" });

  try {
    const dependencies = createRuntimeDependencies({ airtable: true, outscraper: true, notifications: true });
    const result = await runOutscraperWatchdog(request, dependencies);
    console.log(JSON.stringify({ event: "outscraper_watchdog_completed", ...result }));
    return response.status(200).json(result);
  } catch (error) {
    console.error(JSON.stringify({
      event: "outscraper_watchdog_failed",
      code: error.code || "OUTSCRAPER_WATCHDOG_FAILED",
      message: String(error.message || "").slice(0, 300),
      upstreamStatus: error.upstreamStatus || null
    }));
    return response.status(500).json({ success: false, code: error.code || "OUTSCRAPER_WATCHDOG_FAILED" });
  }
}
