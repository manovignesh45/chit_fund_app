# Deploying (Dokploy)

Dokploy is the only deploy path. It clones the repo and runs `docker build` with
`microfinance-app/Dockerfile` (build context `microfinance-app/`). The container listens on **3001**.

On every start the container runs `prisma migrate deploy` and then `node server.js`.
If the migration step fails, the server does not start, and the container exits with an error.

## Dokploy settings

Set these as **runtime** environment variables. Nothing is baked into the image, and `.env` files are excluded from the build context.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres URL. Use a direct (non-pooler) host. `migrate deploy` takes an advisory lock, which a PgBouncer transaction pooler such as Neon's `-pooler` host does not support. |
| `JWT_SECRET` | Long random string. Changing it signs everyone out. |
| `INTERNAL_API_KEY` | Long random string, used by the scheduled jobs. |
| `ADMIN_EMAIL` | Address that receives reports. |
| `SMTP_*` | Mail settings, as listed in `.env.example`. |

- The image sets `NODE_ENV=production`, `PORT=3001` and `HOSTNAME=0.0.0.0`.
- **Do not set `NODE_ENV=development`.**
- The build needs no build args.
- Health check: `GET /api/health`. It returns 200 when the app is up and can reach the database.

Local equivalent: `docker compose up --build`. It uses `.env` as runtime env and maps host port 9693 to container port 3001.

## One-time migration baseline (before the first deploy of this image)

The migrations folder was squashed into `0_init` plus 8 newer migrations:

- `20250613_add_messages`
- `20250613_add_notifications`
- `20250613_add_partner_logins`
- `20250627_add_auction_bookings`
- `20260713_add_chit_fund_templates`
- `20261030_add_notification_entity`
- `20261105_add_loan_recovery`
- `20261106_add_contribution_balance_payment`

The production schema was built by hand or with `db push`, so Prisma does not know which of these migrations it already contains. Running `migrate deploy` against it unbaselined fails with `P3005 The database schema is not empty`, and the container will not start. Baseline it once, as follows.

You can run the Prisma commands from a checkout of this commit (`cd microfinance-app && npx prisma ...`) or from the built image:

```sh
P="docker run --rm -e DATABASE_URL=$PROD_URL --entrypoint node <image> node_modules/prisma/build/index.js"
$P migrate status
```

1. **Back up the database.** Use `pg_dump`, or a Neon branch/snapshot.
2. **See what Prisma thinks:** run `prisma migrate status`. On an unbaselined DB, it lists all 9 migrations as not applied.
3. **Find which newer migrations already exist in prod.** Run this with `psql "$PROD_URL"`:
   ```sql
   SELECT name, present FROM (VALUES
     ('20250613_add_messages',        to_regclass('"Message"') IS NOT NULL),
     ('20250613_add_notifications',   to_regclass('"Notification"') IS NOT NULL),
     ('20250613_add_partner_logins',  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'User' AND column_name = 'partnerId')),
     ('20250627_add_auction_bookings', to_regclass('"AuctionBooking"') IS NOT NULL),
     ('20260713_add_chit_fund_templates', to_regclass('"ChitFundTemplate"') IS NOT NULL),
     ('20261030_add_notification_entity', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Notification' AND column_name = 'entityType')),
     ('20261105_add_loan_recovery',   to_regclass('"LoanRecoveryEvent"') IS NOT NULL),
     ('20261106_add_contribution_balance_payment', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Transaction' AND column_name = 'balanceContributionId'))
   ) AS t(name, present);
   ```
4. **Mark `0_init`, and every migration that showed `present = t`, as applied:**
   ```sh
   $P migrate resolve --applied 0_init
   $P migrate resolve --applied 20250613_add_messages   # ...one per present migration
   ```
   Leave out the migrations that showed `f`. `migrate deploy` applies them on container start.
5. **Check for drift.** Do this from a checkout:
   ```sh
   npx prisma migrate diff --from-url "$PROD_URL" --to-migrations prisma/migrations \
     --shadow-database-url "$SCRATCH_URL" --script
   ```
   - `$SCRATCH_URL` is any empty throwaway Postgres.
   - The output must be empty, apart from two expected kinds of difference:
     - the steps of the migrations you did not resolve;
     - two `CREATE INDEX "User_dataOwnerId_idx"` / `"User_partnerId_idx"` lines, if prod was built by `db push`. They are harmless. You can run them by hand.
   - Any other difference means a migration is only half there. Apply the missing statements by hand from its `migration.sql`, then resolve it. Do not resolve a half-applied migration.
   - Comparing against the schema instead (`--to-schema-datamodel prisma/schema.prisma`) also works for a fully migrated DB. It always shows `DROP INDEX "User_dataOwnerId_idx"` and `DROP INDEX "User_partnerId_idx"`. Those indexes come from `20250613_add_partner_logins` and are not declared in `schema.prisma`. That difference is harmless.
6. **Deploy.** The container's `migrate deploy` applies the remaining migrations. Its log ends with `All migrations have been successfully applied.` or `No pending migrations to apply.`

**Old history rows.** `_prisma_migrations` may still hold rows for the deleted pre-squash migrations (`20250608…`). They are harmless:
- `migrate deploy` ignores them.
- `migrate status` reports them as "not found locally" and exits 0.

To tidy up after a successful deploy, run `DELETE FROM _prisma_migrations WHERE migration_name LIKE '20250608%';`. Take a backup first.

**Verified locally** against a throwaway Postgres:
- A fresh empty DB gets the full schema from the 9 migrations.
- A `db push` DB fails with P3005, then starts after `resolve --applied` of all 9.
- A DB that already holds `0_init` plus the first 4 migrations, plus an old `20250608…` row, gets only the last 4 applied.

## Notes

- **Backups:** the image has no `pg_dump` or `mysqldump`. So `/api/db-backup` and the scheduled DB-backup emails fail inside the container. The scheduled job only supports MySQL URLs anyway. Use Neon/Dokploy backups, or `pg_dump` from another host.
- **Writable paths:** the app runs as user `node` in `/app`. Uploads and other runtime files written under `/app` (e.g. `/app/temp`) are lost on redeploy.
