# Airtable parallel mirror

Airtable remains the source of truth and all reads and writes continue to use Airtable first. When `DATABASE_URL` is configured, every successful Airtable create or update is then documented in Postgres.

The mirror keeps two tables:

- `airtable_mirror_records`: the latest complete Airtable response for each record.
- `airtable_mirror_events`: an append-only history of successful create and update operations.

The schema is created automatically on the first documented write. The equivalent SQL is kept in `ops/airtable-mirror.sql` for inspection.

Mirror failures are fail-open: they are logged as `airtable_mirror_failed`, but do not turn a successful Airtable operation into a failed customer action. Airtable failures never create a mirror event.

The protected `/api/airtable-reconcile` endpoint scans all five Airtable tables using field IDs. It compares stable checksums, backfills new or changed records, and marks missing records without deleting their stored data. `POST` with `{ "dry_run": true }` produces the same parity report without writing. A daily Vercel Hobby cron runs the authenticated `GET` form as a safety net so changes made by active Make scenarios are copied without modifying those scenarios. It uses the existing `CRON_SECRET` bearer token.

`POST /api/airtable-webhook` is the real-time Airtable notification target. Airtable's `X-Airtable-Content-MAC` signature is verified against `AIRTABLE_WEBHOOK_MAC_SECRET`; each valid notification starts the same idempotent checksum reconciliation. The daily safety-net run refreshes the subscription when `AIRTABLE_WEBHOOK_ID` is configured, preventing Airtable's seven-day webhook expiry.

## Activation

1. Add a durable Postgres database to the Vercel project (the Neon integration is the recommended fit for Vercel Functions).
2. Confirm that it provides `DATABASE_URL` to Production.
3. Deploy the current project.
4. Perform a dry-run create/update with mocked Airtable, then one controlled real write.
5. Reconcile Airtable counts and record checksums before using the mirror for reads.

Until `DATABASE_URL` exists, the wrapper returns the original Airtable client and production behavior is unchanged.
