# Make migration status

SiteSnap's migrated automations run as Vercel Functions and no longer depend on Make or on either local computer being online. The shared folder can be used from either computer for maintenance and deployments.

## Production status — 2026-07-16

- Make scenarios 00, 02, 07, 07.5, 08, 09, 10 and 12 are inactive and were not deleted.
- Scenario 00 still has 6 historical records waiting in its Make queue. They were intentionally left untouched; new website leads bypass Make completely.
- Scenario 11 was intentionally skipped and was not changed.
- Scenario 04 remains active. Its embedded sketch-open tracker points to the production scenario-12 replacement endpoint.
- The temporary migration page, test API and migration-only Vercel environment variables were removed after the live checks.
- The Vercel delivery token is stored as a sensitive Preview/Production variable, is scoped to the owning team and expires on 2027-07-14.

## Runtime mapping

| Make scenario | Make ID | Production replacement |
| --- | --- | --- |
| 00 | `b066e90394264c16ad9ee7e09d682844` (webhook slug) | `/api/b066e90394264c16ad9ee7e09d682844-website-leads` |
| 02 | `9205366` | `/api/02-export-email-to-instantly` and its winter-time companion route |
| 07 | `9165920` | `/api/b80bf73b56624b3bb4eb7ab5075eaed2-domain-availability` |
| 07.5 | `9177085` | `/api/d2e5d68217354b4bb6b38dafcdeee9ab-domain-registration` |
| 08 | `9177306` | `/api/1c177b7f64d64fa9a9a4dce318d8d681-stripe-events` |
| 09 | `9129372` | `/api/9cb2a449abf2498ab8de9665800c75d9-existing-domain` |
| 10 | `9095672` | The same Stripe endpoint dispatches the site-delivery payment links |
| 12 | `9246011` | `/api/3b7f5316669d40c19e243c38f67b52ec` |

## Live evidence after Make was turned off

- 00: the public production form submitted a real test lead through the new endpoint. The same lead appeared once in Raw Outscraper and once in Generation Jobs in Airtable, and the matching Telegram notification arrived. Make remained inactive, its last execution stayed on June 17, 2026, and its 6 queued records were unchanged.
- 08: a signed Stripe event returned HTTP 200 through the production endpoint without purchasing or updating anything; a separate Cloudflare safe check confirmed a registrable domain at $10.46 registration and renewal.
- 10: the production workflow deployed and opened `migration-token-final-20260714.trysitesnap.com` after the Vercel delivery token was rotated. The page states that scenario 10 delivered it without Make.
- 12: opening a delivered sketch wrote the timestamp to Airtable and sent the matching Telegram notification. The check was repeated successfully after rotating the Telegram bot token.
- Mail: the Google Apps Script relay sent both a direct test and a message through the production SiteSnap runtime. Its Google authorization is limited to sending mail.
- 02: a protected production run read an eligible Raw Outscraper lead, generated the analysis with Gemini, generated the email with Claude, created the lead in the correct Instantly campaign, wrote the complete outgoing Email Threads record in Airtable, and delivered the Telegram summary. The same run returned HTTP 200 in Vercel. The lead and audit record were verified in the provider UIs before Make was deactivated.
- 02 v2: production now uses one Claude structured-output call instead of the Gemini-to-Claude chain. A protected production test generated three different customer-specific emails and redirected all three exclusively to `levy.dave.1@gmail.com`. The endpoint returned HTTP 200 with `flow: v2` and `sent: 3`; Gmail showed exactly the matching three messages. No Instantly lead or Airtable Email Threads record is created by this test route.

Production test record used during cutover: `recwrMbu32Qy4Jc87`.
Scenario 02 production test Raw record: `recdfAC9tau5DtoS1`.

## Production secrets

Secrets are stored only in Vercel or the corresponding provider, never in Git or this shared folder. The runtime uses:

- `CLOUDFLARE_API_TOKEN`
- `STRIPE_WEBHOOK_SECRET`
- `VERCEL_DELIVERY_TOKEN`
- `MAIL_RELAY_URL` and `MAIL_RELAY_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `OUTSCRAPER_API_KEY`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `INSTANTLY_API_KEY`
- `CRON_SECRET`
- `EMAIL_EXPORT_MAX_RECORDS`
- `EMAIL_EXPORT_FLOW` (`v2` in production; change to `legacy` for model-flow rollback)
- `EMAIL_PREVIEW_TEST_SECRET`
- `OVERTURE_INGEST_SECRET` is optional for manual integrations. The GitHub discovery workflow authenticates with a short-lived signed identity instead of storing a shared secret.

## Scenario 02 operating notes

- Vercel owns the schedule, so scenario 02 does not depend on either local computer or on the shared folder being open.
- Two UTC cron entries cover Israeli daylight-saving and winter time. Each route checks that the local hour in `Asia/Jerusalem` is 12 before doing work, preventing a duplicate daily run.
- The production batch limit is 200 eligible leads. Malformed source email addresses are ignored before the limit is applied, so an invalid oldest row cannot block the queue.
- Instantly duplicate guards and the Neon `queued` audit record make retries safe for already-exported Raw records. `queued` means the lead was added to the campaign; it does not claim that Instantly has already sent the message.
- Vercel Hobby cron execution has a flexible one-hour window. The run is therefore expected during the 12:00–12:59 Israel-time hour, not necessarily at exactly 12:00:00.
- Production uses the v2 one-model flow: one Claude structured-output request receives the verified Airtable lead fields and returns the subject/body JSON directly. Gemini is not initialized or called in v2.
- The original Gemini-to-Claude chain and its exact prompts remain in the code as the `legacy` flow. Set `EMAIL_EXPORT_FLOW=legacy` in Vercel and redeploy to roll back without restoring code or reactivating Make.
- `/api/02-email-preview-test` is a protected, non-exporting test route. It requires exactly three Airtable Raw record IDs, can send only to the hard-coded approved inbox `levy.dave.1@gmail.com`, and neither calls Instantly nor writes to Airtable.
- The v2 first email intentionally omits finished-site pricing. It truthfully offers to prepare a tailored homepage concept, uses at most one grounded detail and one practical benefit, and asks permission before work begins. It states that preparing and viewing the concept has no cost or obligation, without implying that the finished website or launch is free. The `$199` offer belongs in a follow-up after interest.

## Overture lead discovery

- Overture Places replaces paid discovery for the new lead source. A daily GitHub Actions job scans the current public Parquet release by a rotating US state group and a broad local-business category profile; it can also be started manually.
- The seven rotating regions cover all 50 states and DC: Pacific, South Central, Southeast, Northeast, Midwest, South, and Mountain/Plains. Manual runs can override them with `states`.
- Category targeting is split into six practical groups: `home_trades`, `property_exterior`, `cleaning_restoration`, `auto_transport`, `health_beauty`, and `professional_events`. Manual runs can select a subset with `category_groups`.
- Discovery stages every row returned by the configured scan in 25-row transport batches. The 50-row API ceiling is only a request-size guard; it is not a lead target and does not stop processing after 50.
- The ingestion route filters closed locations and known chains/franchises, performs syntax, disposable-domain and mail-DNS checks, scores business fit and deduplicates by Overture place, stable fallback identity and email.
- Qualified businesses without an email are retained as `Lead Status=candidate` for later enrichment. Qualified rows with a locally valid email are stored as `Lead Status=enriched`, `PENDING_EXTERNAL_VERIFICATION`, `Email Eligible=no` and `Lead Decision=pending_verification`.
- Rejected businesses are retained once with the basic business fields, score and rejection reason. Unique Neon indexes on place, dedupe key and email make ingestion idempotent even across concurrent runs.
- External verification stores provider, checked time, normalized result, catch-all/disposable/risky flags and the original result JSON. The canonical lead status is one of `candidate`, `enriched`, `verified`, `approved`, `transferred`, `sent` or `rejected`.
- Scenario 02 enforces that gate. Only a fresh external result of `GOOD`, `OK`, `VALID` or `DELIVERABLE`, with a named provider and no catch-all flag, can make an Overture row exportable.
- Instantly verification is explicitly disabled on import. This prevents verification-credit usage there.
- Stage 4 enriches Overture candidates without Instantly or MillionVerifier. It searches an existing Overture address, the official website, Contact/About pages, JSON-LD structured data, official social profiles and finally other public URLs already linked to the business record.
- A discovered address is accepted only after syntax, disposable-domain and MX/A-DNS checks and a database-wide duplicate check. The exact public source URL, source type, attempted pages, outcomes and timestamp are stored with the lead; guessed addresses are never generated.
- A found address remains `Email Eligible=no` and `pending_verification`. A current safe external verification can be marked reusable for stage 5, but stage 4 cannot approve or send the lead.
- No-result searches are documented and paused for 30 days; temporary errors retry after one day. The scheduled workflow processes up to five 15-lead enrichment batches after discovery, requesting a new short-lived identity for every batch.
- Public-page fetching accepts only HTTP(S) on standard ports, blocks local/private/reserved destinations and limits redirects, time, page count and response size.
- A protected GET on `/api/overture-leads` returns the pending verification batch. A protected POST with `action=verification_results` imports the later batch results; neither operation sends email by itself.
- A protected POST on `/api/overture-enrichment` runs stage 4 only. It does not initialize any Instantly, AI or external-verification client.
- GitHub Actions uses a short-lived signed identity token. The route accepts it only from `levydave1/trysitesnap`, the `main` branch and the scheduled/manual Overture workflow, so no new shared GitHub/Vercel secret is required. The existing `CRON_SECRET` remains available for protected manual batch export/import.
- The workflow applies the idempotent lead schema guard before discovery. It backfills canonical statuses, refuses to hide existing duplicates, and installs the unique indexes and status constraint. `npm run db:lead-schema` remains available for maintenance outside the workflow.

## Operations dashboard

- `/lead-dashboard` is the private operational view for the full system, not only the Overture pipeline.
- It reads the five Neon tables that replaced Airtable, distinguishes untouched Airtable snapshot records from records created or updated locally after cutover, and supports protected search across the complete history.
- The overview combines lead sources and decisions, stage-4 email-finding results, verification state, Instantly queue history, generation jobs, sketches, orders/domains, system dependencies and recent activity.
- Pending verification email addresses can be downloaded as CSV. A later external-result CSV can be reviewed and imported from the same dashboard; the server still enforces the strict approval gate.
- Access uses an HTTP-only signed session cookie backed by the Vercel Secret `DASHBOARD_ACCESS_KEY`; the key is never embedded in the page or repository.
- The protected maintenance action `dedupe_unsent_leads` removes only later copies of exact, uncontacted Outscraper duplicates. It requires an explicit confirmation phrase and preserves the earliest record in every identical group.
- On 2026-11-25 the action removed 495 later copies from 495 exact pairs after confirming that none was referenced by an email thread, generation job, business or order. Raw lead count changed from 5,958 to 5,463; a second dry run found zero remaining safe duplicate groups.

The Stripe webhook signing secret still needs a security rotation. Stripe requires the account owner to complete a passkey or phone verification before it will reveal the replacement secret; the currently active secret and webhook remain operational until that verification is completed.

## Airtable data cutover — 2026-11-20

- The independent `sitesnap-data` Neon Postgres database is connected to Vercel Production and Preview in region `iad1`.
- The local Airtable snapshot was imported with 10,267 structured records: 92 Generation Jobs, 1 Orders Domains, 5,911 Raw Outscraper, 4,225 Email Threads and 38 Businesses.
- All five table counts and content checksums match the snapshot. Field-ID compatibility and a create/read/delete smoke test also passed.
- Production and Preview select the new database with `DATA_BACKEND=postgres`. `/api/02-email-preview-test?health=data-store` performs a live query without exposing customer data or sending email.
- On 2026-11-22 the Airtable token was removed from the local environment and from Vercel Production/Preview. Postgres is also the runtime default if `DATA_BACKEND` is absent. Reconnecting Airtable would now require deliberately adding a new token and selecting the Airtable backend.
- The `SiteSnap Local Service Watchdog` Windows task is disabled (not deleted), and the old local Airtable server/sync processes were stopped. The production health query still passed afterward, confirming that the live system no longer depends on this computer or shared folder being online.
- The 52 actual Airtable attachments are dated 2026-05-11 through 2026-07-20 (about 42 MB), and all 52 have local copies. They are not used by the active runtime; loss of their original Airtable URLs was accepted during the final disconnect.

## Rollback rule

Keep the inactive Make scenarios as a temporary reference during the staged migration. Do not reactivate them unless intentionally rolling back, because running Make and the Vercel replacement together could duplicate external actions.
