# Make migration: scenarios 07, 07.5 and 09

This branch replaces the three browser-facing Make webhooks with Vercel Functions in the existing SiteSnap project.

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

The production runtime is Vercel, so the shared folder and either computer can be used for maintenance without being required to stay online.
