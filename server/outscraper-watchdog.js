import { recoverLatestOutscraperImport } from "./outscraper-webhook.js";

function text(value) {
  return String(value ?? "").trim();
}

function localWeekday(now, timezone) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now);
}

function recentOutscraperImport(records, now, lookbackHours) {
  const cutoff = now.getTime() - (lookbackHours * 60 * 60 * 1000);
  return records.some((record) => {
    const fields = record.fields || {};
    if (text(fields["Source System"]).toLowerCase() !== "outscraper") return false;
    const timestamp = Date.parse(fields["Last Seen At"]);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}

function webhookUrl(request, path) {
  const forwardedHost = text(request.headers?.["x-forwarded-host"]);
  const host = forwardedHost || text(request.headers?.host);
  if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw new Error("Cannot determine watchdog webhook host");
  return `https://${host}${path}`;
}

export async function runOutscraperWatchdog(request, dependencies, options = {}) {
  const now = options.now || new Date();
  const cfg = dependencies.config.outscraper;
  const recovery = await recoverLatestOutscraperImport(dependencies, { notify: true });
  const records = await dependencies.airtable.listRecords(
    dependencies.config.airtable.rawOutscraperTableId,
    { fields: ["Source System", "Last Seen At"] }
  );
  if (recentOutscraperImport(records, now, cfg.watchdogLookbackHours)) {
    return { success: true, action: recovery.recovered ? "recovered" : "recent_import", recovery };
  }

  const activeRequests = await dependencies.outscraper.listRequests({ type: "active", pageSize: 20 });
  if (activeRequests.length) {
    return { success: true, action: "active_request", active: activeRequests.length, recovery };
  }

  const weekday = localWeekday(now, dependencies.config.emailExport.timezone);
  const daily = cfg.fallbackRegionsByLocalWeekday[weekday];
  if (!daily) throw new Error(`No Outscraper fallback region for ${weekday}`);
  const queries = daily.states.flatMap((state) => cfg.fallbackCategories.map((category) => `${category}, ${state}, US`));
  const started = await dependencies.outscraper.startGoogleMapsSearch({
    queries,
    totalLimit: cfg.fallbackTotalLimit,
    perQueryLimit: cfg.fallbackPerQueryLimit,
    skipPlaces: cfg.fallbackSkipPlaces,
    language: cfg.language,
    region: cfg.region,
    enrichments: ["contacts_n_leads", "company_insights_service", "emails_validator_service"],
    webhook: webhookUrl(request, cfg.webhookPath)
  });
  const result = {
    success: true,
    action: "fallback_started",
    title: daily.title,
    requestId: text(started?.id),
    status: text(started?.status),
    queryCount: queries.length,
    recovery
  };
  if (dependencies.telegram) {
    try {
      await dependencies.telegram.send(`⚠️ Outscraper scheduled run was missing\nFallback started: ${daily.title}\nRequest: ${result.requestId || "pending"}`);
    } catch (error) {
      console.error(JSON.stringify({ event: "outscraper_watchdog_notification_failed", message: text(error?.message).slice(0, 200) }));
    }
  }
  return result;
}

export { recentOutscraperImport };
