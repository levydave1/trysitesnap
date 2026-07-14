# Make migration: scenarios 07, 07.5 and 09

This project replaces the three browser-facing Make webhooks with Vercel Functions in the existing SiteSnap project.

## Current production status

- Completed and verified on 2026-07-14.
- Production commit: `634ad0b` on `main`.
- Verified in a Vercel Preview, on `trysitesnap.com`, and again on `trysitesnap.com` after Make was turned off.
- Make scenarios `9165920` (07), `9177085` (07.5), and `9129372` (09) are inactive and were not deleted.
- Airtable verification record: `recwrMbu32Qy4Jc87` (clearly marked as migration test data).
- Production is hosted by Vercel and does not depend on either local computer being online.

## Runtime mapping

| Make scenario | Website endpoint | Upstream service |
| --- | --- | --- |
| 07 | `/api/b80bf73b56624b3bb4eb7ab5075eaed2-domain-availability` | Cloudflare Registrar |
| 07.5 | `/api/d2e5d68217354b4bb6b38dafcdeee9ab-domain-registration` | Airtable |
| 09 | `/api/9cb2a449abf2498ab8de9665800c75d9-existing-domain` | Airtable |

## Vercel secrets

Add these encrypted environment variables for Preview and Production:

- `CLOUDFLARE_API_TOKEN`: account-scoped token with Registrar write permission for account `7502f6ada6e0d09a80d12924fb90c4fb`.
- `AIRTABLE_ACCESS_TOKEN`: personal access token with record write access restricted to base `appHTGFZeyuXbRmvt`.

Do not put either value in this shared folder or in Git.

## Cutover checklist

1. Run unit and syntax tests.
2. Deploy a branch preview with both secrets.
3. Test scenario 07 against Cloudflare through the preview purchase page.
4. Create a clearly marked Airtable migration-test record and test 07.5 and 09 against it.
5. Deploy the same commit to Production and repeat the browser tests on `trysitesnap.com`.
6. Turn off (do not delete) Make scenarios 07, 07.5 and 09.
7. Repeat all production tests while Make remains off.

All seven steps above were completed successfully. Leave the three Make scenarios inactive as a rollback reference; do not delete them during the staged migration.

The production runtime is Vercel, so the shared folder and either computer can be used for maintenance without being required to stay online.

## In progress: scenarios 08, 10 and 12

The replacement code is deployed on `main` and has been exercised in Production. The Make scenarios remain active until the remaining credentials and cutover checks are complete.

| Make scenario | Make ID | Replacement endpoint | Production verification |
| --- | --- | --- | --- |
| 08 | `9177306` | `/api/1c177b7f64d64fa9a9a4dce318d8d681-stripe-events` | Safe Cloudflare check passed at $10.46 registration and renewal; no purchase was made |
| 10 | `9095672` | same Stripe endpoint | Deployed and opened `migration-production3-20260714.trysitesnap.com` without Make |
| 12 | `9246011` | `/api/3b7f5316669d40c19e243c38f67b52ec` | GET compatibility passed and the delivered site's cross-origin tracker reported `recorded` |

Scenario 11 (`9235829`) is intentionally skipped and must not be changed. Scenario 04 remains active; its embedded scenario-12 webhook URL must be changed to the opaque Production endpoint above before scenario 12 is turned off.

Production test record: `recwrMbu32Qy4Jc87`. The delivery flow includes bounded Vercel deployment readiness and SSL-certificate retries, both found and verified during live Production testing.

### Remaining cutover work

1. Import the single-URL blueprint change into scenario 04 and save it without running the scenario.
2. Configure and verify `STRIPE_WEBHOOK_SECRET`, `MAIL_RELAY_URL`, the mail relay property, and `TELEGRAM_BOT_TOKEN`.
3. Re-run Production checks with email and Telegram notifications enabled.
4. Turn off, but do not delete, Make scenarios 08, 10 and 12.
5. Repeat the Production checks while those Make scenarios are inactive.
6. Remove the temporary migration-test surface and rotate the Vercel delivery token after the old Make token is no longer needed.
