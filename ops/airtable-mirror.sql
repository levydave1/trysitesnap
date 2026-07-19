CREATE TABLE IF NOT EXISTS airtable_mirror_records (
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  fields JSONB NOT NULL,
  last_operation TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL,
  checksum TEXT,
  airtable_created_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  present_in_airtable BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (table_id, record_id)
);

CREATE TABLE IF NOT EXISTS airtable_mirror_events (
  event_id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  fields JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS airtable_mirror_events_record_idx
ON airtable_mirror_events (table_id, record_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS airtable_reconciliation_runs (
  run_id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  dry_run BOOLEAN NOT NULL,
  source TEXT NOT NULL,
  summary JSONB NOT NULL
);
