import { neon } from "@neondatabase/serverless";
import { config } from "../server/config.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");

const sql = neon(process.env.DATABASE_URL);
const tableId = config.airtable.rawOutscraperTableId;

await sql.query(
  `UPDATE sitesnap_records
   SET fields = fields || jsonb_build_object(
     'Lead Status', CASE
       WHEN LOWER(fields->>'Lead Decision')='approved' THEN 'approved'
       WHEN LOWER(fields->>'Lead Decision')='rejected' THEN 'rejected'
       WHEN LOWER(fields->>'Lead Decision')='pending_verification' THEN 'enriched'
       WHEN LOWER(fields->>'Lead Decision')='pending_enrichment' THEN 'candidate'
       ELSE 'candidate'
     END,
     'Lead Status Updated At', COALESCE(NULLIF(fields->>'Lead Status Updated At',''), updated_at::text),
     'Lead Decision Reason', COALESCE(
       NULLIF(fields->>'Lead Decision Reason',''),
       NULLIF(fields->>'Lead Rejection Reason',''),
       UPPER(COALESCE(NULLIF(fields->>'Lead Decision',''), 'IMPORTED'))
     )
   ), updated_at=NOW()
   WHERE table_id=$1
     AND LOWER(fields->>'Source System')='overture'
     AND COALESCE(fields->>'Lead Status','')=''`,
  [tableId]
);

const duplicatePlaces = await sql.query(
  `SELECT LOWER(fields->>'Place ID') AS value, COUNT(*)::int AS count
   FROM sitesnap_records
   WHERE table_id=$1 AND LOWER(fields->>'Source System')='overture'
     AND COALESCE(fields->>'Place ID','')<>''
   GROUP BY LOWER(fields->>'Place ID') HAVING COUNT(*)>1 LIMIT 20`,
  [tableId]
);
const duplicateDedupKeys = await sql.query(
  `SELECT LOWER(fields->>'Dedup Key') AS value, COUNT(*)::int AS count
   FROM sitesnap_records
   WHERE table_id=$1 AND LOWER(fields->>'Source System')='overture'
     AND COALESCE(fields->>'Dedup Key','')<>''
   GROUP BY LOWER(fields->>'Dedup Key') HAVING COUNT(*)>1 LIMIT 20`,
  [tableId]
);
const duplicateEmails = await sql.query(
  `SELECT LOWER(fields->>'Email') AS value, COUNT(*)::int AS count
   FROM sitesnap_records
   WHERE table_id=$1 AND LOWER(fields->>'Source System')='overture'
     AND COALESCE(fields->>'Email','')<>''
   GROUP BY LOWER(fields->>'Email') HAVING COUNT(*)>1 LIMIT 20`,
  [tableId]
);

if (duplicatePlaces.length || duplicateDedupKeys.length || duplicateEmails.length) {
  throw new Error(`Overture duplicates must be resolved before adding unique indexes: ${JSON.stringify({
    placeIds: duplicatePlaces,
    dedupKeys: duplicateDedupKeys,
    emails: duplicateEmails
  })}`);
}

await sql.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS sitesnap_overture_place_unique_idx
   ON sitesnap_records(table_id,LOWER(fields->>'Place ID'))
   WHERE LOWER(fields->>'Source System')='overture' AND COALESCE(fields->>'Place ID','')<>''`
);
await sql.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS sitesnap_overture_dedup_key_unique_idx
   ON sitesnap_records(table_id,LOWER(fields->>'Dedup Key'))
   WHERE LOWER(fields->>'Source System')='overture' AND COALESCE(fields->>'Dedup Key','')<>''`
);
await sql.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS sitesnap_overture_email_unique_idx
   ON sitesnap_records(table_id,LOWER(fields->>'Email'))
   WHERE LOWER(fields->>'Source System')='overture' AND COALESCE(fields->>'Email','')<>''`
);
await sql.query(
  `DO $$ BEGIN
     ALTER TABLE sitesnap_records ADD CONSTRAINT sitesnap_overture_lead_status_check CHECK (
       LOWER(fields->>'Source System')<>'overture'
       OR LOWER(fields->>'Lead Status') IN ('candidate','enriched','verified','approved','transferred','sent','rejected')
     ) NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`
);
await sql.query("ALTER TABLE sitesnap_records VALIDATE CONSTRAINT sitesnap_overture_lead_status_check");

console.log(JSON.stringify({ success: true, tableId }));
