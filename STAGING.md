# Staging (redesign)

Production is untouched: branch `main` → the existing Vercel project → the live site
`seoteamtargets.vercel.app` → the production MongoDB. All redesign work happens on **`staging-v2`**,
and staging runs **locally** on your machine with its own local database.

## Start / stop

```bash
npm install            # first time only
npm run dev:staging    # → http://localhost:3001
```

This one command:
1. Creates `.env.staging` on first run, with `APP_ENV=staging`, database `rankorbit_staging`,
   the local database URL and a random `SESSION_SECRET`.
2. Starts the local staging database on `127.0.0.1:27018`, or reuses one that is already running.
   - **Linux:** FerretDB (MongoDB-compatible), downloaded once.
   - **Windows/macOS:** MongoDB `mongod`, taken from your PATH or downloaded once.
3. Seeds the test data on the very first run only.
4. Runs the app on port 3001.

**Stop:** press **Ctrl+C**. This stops the app and the database the command started.

Everything local lives in `.staging-db/` (database files, the downloaded database program, logs).
The data **survives restarts**. To start from a clean database, delete `.staging-db/` and run the
command again. `.staging-db/` and `.env.staging` are git-ignored and are never committed.

**Reset test data:** run `npm run seed:staging`. It replaces the `test.*` users' entries and
attendance, and leaves other staging data alone.

## Test logins

Password for all three: `staging-test-123`

| Username | Opens |
|---|---|
| `test.manager` | Dashboard (all tabs; the monitor page opens but has no live screens) |
| `test.member1` | Member portal, with 3 days of TEST entries and attendance |
| `test.member2` | Member portal, with 3 days of TEST entries and attendance |

The app also copies its normal employee account list from code into the staging database, as it
does in production. No production entries, attendance or settings are ever copied.

## Safety guard (built into `server.js`)

A run counts as staging when `APP_ENV` is set to anything other than `production`, when it is a
Vercel preview, or when it is a Vercel build of any branch other than `main`. In staging:

- The server **refuses to start** unless the database name contains `staging`.
- Screen sharing and screenshots are **off**. The Pusher, LiveKit and Cloudinary keys (including
  the production ones in `vercel.json`) are ignored; only `STAGING_*` keys are used, and none are set.
- Sessions are cleaned by a timer, because the local database has no auto-expiry indexes.

On `main` in production none of this applies, and every function and environment variable works
exactly as today. One side effect after promotion: Vercel *preview* builds of other branches will
also refuse to start unless they are given a staging database. That is intended, so previews can
never write to live data.

## Going live later (one command)

```bash
npm run promote
```

1. Asks you to type `PROMOTE`; anything else cancels.
2. Stops if you are not on `staging-v2`, if anything is uncommitted, or if `staging-v2` is not
   fully pushed.
3. Merges `staging-v2` into `main` and pushes.
4. Vercel auto-deploys `main` to the live site, exactly as it does today.
5. Prints rollback steps: Vercel **Instant Rollback**, or `git revert`.

It never touches any database or Vercel setting. Staging data is not copied to production.

## Optional, later — not required

These are deferred and not needed for local staging:
- A hosted staging site: a separate Vercel project `rank-orbit-staging` with Production Branch
  `staging-v2`, plus `APP_ENV=staging` and the variables listed in `.env.staging.example`.
- A MongoDB Atlas staging database user limited to `rankorbit_staging`.
- Separate Pusher, LiveKit and Cloudinary accounts (`STAGING_*` variables) for testing live
  screen sharing in staging.
