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
- **Starts clean (for real testing by the team).** On Vercel the staging database is emptied
  **once**, the first time this version starts (`lib/clean-start.js`; a `cleanStart` marker in
  `configs` stops it from ever happening again, so everything created while testing stays).
  No test accounts and no TEST data are seeded there. The real employee list from the code is
  not loaded either.
- **First manager account.** With no manager yet, the sign-in page shows **Create the manager
  account** (name, username, password of 8+ characters). After that it is a normal sign-in page;
  add the team, tasks and clients from the dashboard (Settings, Clients).
- **Banner.** Every page shows a fixed "TEST VERSION — not the live site yet" bar.
- **Local staging is unchanged:** `npm run dev:staging` still seeds the test accounts below for the
  automated tests. `STAGING_CLEAN=1` runs the clean mode locally.

**Where to find the URL:** on GitHub, open the latest commit on `staging-v2` and click the Vercel
deployment's **Details** link. If Vercel asks you to log in, that is Vercel's preview protection:
log in with your Vercel account and the page opens.

## Test logins (local staging only)

The password for the test accounts is the value of `STAGING_TEST_PASSWORD` (on Vercel: the
preview environment variable; locally: `.env.staging`). If it is not set, the default in
`lib/staging-seed.js` is used — `npm run seed:staging` also prints it. These are fake test
accounts on the staging database only.

> Stop the local staging server before `npm run seed:staging`: a running server keeps
> accounts removed by the reset in memory until it restarts.

| Username | Opens |
|---|---|
| `test.manager` | Dashboard (all tabs) |
| `test.member1` | Member portal, with 3 days of TEST entries and attendance |
| `test.member2` | Member portal, with 3 days of TEST entries and attendance |
| `test.ov.a` … `test.ov.d` | Demo members for the Overview (one per state / Needs Attention rule) |

**Demo day.** Once a day (the first start of the day) staging rebuilds "today" so the manager
Overview always shows every state: Member One working at 75% of target, Member Two absent,
OV A with an entry but no attendance, OV B on a break and under 50% for 3 working days, OV C
finished without an entry, OV D working with a note. The TEST OV accounts are reset every day;
Member One's day is only filled if it is still empty, so your own testing is kept.
`npm run seed:staging` forces a full reset (local only).

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
