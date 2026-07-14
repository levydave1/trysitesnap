# Make migration status

SiteSnap's migrated automations run as Vercel Functions and no longer depend on Make or on either local computer being online. The shared folder can be used from either computer for maintenance and deployments.

## Production status — 2026-07-14

- Make scenarios 00, 07, 07.5, 08, 09, 10 and 12 are inactive and were not deleted.
- Scenario 00 still has 6 historical records waiting in its Make queue. They were intentionally left untouched; new website leads bypass Make completely.
- Scenario 11 was intentionally skipped and was not changed.
- Scenario 04 remains active. Its embedded sketch-open tracker points to the production scenario-12 replacement endpoint.
- The temporary migration page, test API and migration-only Vercel environment variables were removed after the live checks.
- The Vercel delivery token is stored as a sensitive Preview/Production variable, is scoped to the owning team and expires on 2027-07-14.

## Runtime mapping

| Make scenario | Make ID | Production replacement |
| --- | --- | --- |
| 00 | `b066e90394264c16ad9ee7e09d682844` (webhook slug) | `/api/b066e90394264c16ad9ee7e09d682844-website-leads` |
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

Production test record used during cutover: `recwrMbu32Qy4Jc87`.

## Production secrets

Secrets are stored only in Vercel or the corresponding provider, never in Git or this shared folder. The runtime uses:

- `CLOUDFLARE_API_TOKEN`
- `AIRTABLE_ACCESS_TOKEN`
- `STRIPE_WEBHOOK_SECRET`
- `VERCEL_DELIVERY_TOKEN`
- `MAIL_RELAY_URL` and `MAIL_RELAY_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `OUTSCRAPER_API_KEY`

The Stripe webhook signing secret still needs a security rotation. Stripe requires the account owner to complete a passkey or phone verification before it will reveal the replacement secret; the currently active secret and webhook remain operational until that verification is completed.

## Rollback rule

Keep the inactive Make scenarios as a temporary reference during the staged migration. Do not reactivate them unless intentionally rolling back, because running Make and the Vercel replacement together could duplicate external actions.
