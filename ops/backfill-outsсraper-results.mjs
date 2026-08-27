import { readFile } from "node:fs/promises";
import { createAirtableClient } from "../server/clients.js";
import { config } from "../server/config.js";
import { airtableFieldsForLead, selectLeadRows } from "../server/outscraper-webhook.js";

const apply = process.argv.includes("--apply");
const inputPath = process.argv.find((argument) => argument.endsWith(".json"));
if (!inputPath) throw new Error("Usage: node ops/backfill-outsсraper-results.mjs <input.json> [--apply]");
if (!process.env.AIRTABLE_ACCESS_TOKEN) throw new Error("AIRTABLE_ACCESS_TOKEN is not configured");

const input = JSON.parse(await readFile(inputPath, "utf8"));
const runs = Array.isArray(input?.runs) ? input.runs : [];
if (!runs.length) throw new Error("Backfill input has no runs");

const airtable = createAirtableClient({
  baseId: config.airtable.baseId,
  tableId: config.airtable.tableId,
  accessToken: process.env.AIRTABLE_ACCESS_TOKEN,
  timeoutMs: config.upstreamTimeoutMs
});
const existing = await airtable.listRecords(config.airtable.rawOutscraperTableId, {
  fields: ["CID", "Google ID", "Place ID", "Email"]
});

const report = [];
for (const run of runs) {
  const rows = Array.isArray(run?.rows) ? run.rows : [];
  const { discovered, selected } = selectLeadRows({ data: rows }, existing, config.outscraper.dailyMaxLeads);
  const mapped = selected.map((row) => airtableFieldsForLead(row, {
    runName: String(run?.name || "Outscraper recovery").slice(0, 200),
    now: run?.completedAt ? new Date(run.completedAt) : new Date()
  }));
  const created = [];
  if (apply) {
    for (let index = 0; index < mapped.length; index += 10) {
      created.push(...await airtable.createRecords(
        config.airtable.rawOutscraperTableId,
        mapped.slice(index, index + 10),
        { typecast: true }
      ));
      if (index + 10 < mapped.length) await new Promise((resolve) => setTimeout(resolve, 225));
    }
  }

  // Keep later files in the same recovery run from selecting the same lead.
  existing.push(...mapped.map((fields, index) => ({
    id: created[index]?.id || `dry-run-${run?.name || "run"}-${index}`,
    fields
  })));
  report.push({
    name: run?.name || null,
    discovered,
    eligibleNew: mapped.length,
    created: created.length
  });
}

console.log(JSON.stringify({ apply, report, totalCreated: report.reduce((sum, item) => sum + item.created, 0) }, null, 2));
