# Staging (redesign)

Production is untouched: branch `main` → the existing Vercel project → the live site
`seoteamtargets.vercel.app` → the production database. All redesign work happens on **`staging-v2`**.

## Main path: the Vercel preview of `staging-v2`

Every push to `staging-v2` makes the existing Vercel Git integration build a **Preview** deployment
of that branch automatically. No dashboard setup is needed. The code detects the preview by itself
(`VERCEL_ENV=preview`) and switches into staging mode:

- **Separate database.** It uses the same connection string as the deployment, but the database
  name is forced in code to **`rankorbit_staging`**. The server also refuses to start if the name
  does not contain `staging`.
- **Test accounts only.** The real employee list is not loaded. On first start the app seeds only
  the test accounts and their TEST entries and attendance. Seeding uses upserts, so restarts never
  duplicate anything.
- **Screen sharing and screenshots are off.** The Pusher, LiveKit and Cloudinary keys (including
  the production ones in `vercel.json`) are ignored in staging.
- **Banner.** Every page shows a fixed "STAGING — test data only" bar.

**Where to find the URL:** on GitHub, open the latest commit on `staging-v2` and click the Vercel
deployment's **Details** link. If Vercel asks you to log in, that is Vercel's preview protection:
log in with your Vercel account and the page opens.

## Test logins

Password for all three: `staging-test-123`

| Username | Opens |
|---|---|
| `test.manager` | Dashboard (all tabs; the monitor page opens but has no live screens) |
| `test.member1` | Member portal, with 3 days of TEST entries and attendance |
| `test.member2` | Member portal, with 3 days of TEST entries and attendance |

## When staging mode switches on

A run counts as staging when any of these is true:
- `APP_ENV` is set to anything other than `production`
- `VERCEL_ENV=preview`
- Vercel is building any branch other than `main`

On `main` in production none of this applies, and every function and environment variable works
exactly as today. Old `main` and `staging-v2` were checked side by side in production mode and gave
byte-identical responses.

After promotion, Vercel previews of *other* branches will also use `rankorbit_staging` instead of the
live database. That is intended.

## Optional: run staging on your own computer (developer option)

```bash
npm install
npm run dev:staging      # → http://localhost:3001   (Ctrl+C stops it)
npm run seed:staging     # reset the test data
```

This creates `.env.staging` and a persistent local database in `.staging-db/`. On Linux that is
FerretDB; on Windows and macOS it is MongoDB `mongod`, downloaded once. Both are git-ignored.
Delete `.staging-db/` to start clean.

## Going live later (one command)

```bash
npm run promote
```

1. Asks you to type `PROMOTE`.
2. Stops if you are not on `staging-v2`, if anything is uncommitted, or if `staging-v2` is not
   fully pushed.
3. Merges `staging-v2` into `main` and pushes.
4. Vercel auto-deploys `main` to the live site with its current environment variables, exactly as
   it does today.
5. Prints rollback steps: Vercel **Instant Rollback**, or `git revert`.

It never touches any database or Vercel setting. Staging data is not copied to production.

## Optional, later — not required

- A separate Vercel project for staging, or a MongoDB Atlas user limited to `rankorbit_staging`.
- Separate Pusher, LiveKit and Cloudinary accounts (`STAGING_*` variables, see
  `.env.staging.example`) for testing live screen sharing in staging.
