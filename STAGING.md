# Staging environment (redesign)

Production stays exactly as it is: branch `main` → existing Vercel project → live domain
`seoteamtargets.vercel.app` → production MongoDB. All redesign work happens on **`staging-v2`**.

| | Production | Staging |
|---|---|---|
| Branch | `main` | `staging-v2` |
| Vercel project | existing project (unchanged) | new project **`rank-orbit-staging`** |
| URL | `seoteamtargets.vercel.app` | `rank-orbit-staging.vercel.app` (Vercel default) |
| Database | production DB (unchanged) | `rankorbit_staging` (same cluster is fine) |
| Pusher / LiveKit / Cloudinary | production keys | `STAGING_*` keys, or switched off |

## Built-in safety guard (`server.js`)

The server treats a run as **staging** when any of these is true: `APP_ENV` is set to anything
other than `production`, `VERCEL_ENV=preview`, or Vercel is building a branch other than `main`.
In staging it:

1. **Refuses to start** unless the database name contains `staging`.
2. Uses Pusher/LiveKit/Cloudinary keys **only** from `STAGING_*` variables. The production keys in
   `vercel.json` are ignored, so staging can never message or view the live team's screens.

On `main` in production none of this applies, and behaviour is unchanged.

## One-time setup (Vercel and MongoDB dashboards)

1. **MongoDB Atlas.** Use the same cluster. Recommended: create a separate database user with
   `readWrite` on `rankorbit_staging` **only**, so staging credentials cannot touch production
   even by mistake. The database itself is created on the first write.
2. **Vercel → Add New → Project →** import `gerirankorbit-coder/seoteamtargets` again and name it
   `rank-orbit-staging`.
3. In the new project, open **Settings → Git → Production Branch** and set it to `staging-v2`.
4. In the new project, open **Settings → Environment Variables** and add the variables below.
5. Deploy. Do **not** add any custom domain to this project.
6. Seed the staging database once from your computer: `npm run seed:staging`.

Nothing in the existing production project needs to change. A push to `staging-v2` may also create a
*Preview* in the production project. That preview cannot reach production data, because the guard
stops it unless it has been given a staging database.

## Environment variables

| Name | Production | Staging |
|---|---|---|
| `APP_ENV` | not set | `staging` |
| `MONGODB_URI` | production connection string | staging user's connection string (same cluster is OK) |
| `MONGODB_DB_NAME` | not set | `rankorbit_staging` |
| `SESSION_SECRET` | production secret | a **different** random string |
| `STAGING_TEST_PASSWORD` | — | optional, password for the `test.*` users |
| `STAGING_PUSHER_APP_ID`, `STAGING_PUSHER_KEY`, `STAGING_PUSHER_SECRET`, `STAGING_PUSHER_CLUSTER` | — | optional, a separate Pusher app |
| `STAGING_LIVEKIT_URL`, `STAGING_LIVEKIT_API_KEY`, `STAGING_LIVEKIT_API_SECRET` | — | optional, a separate LiveKit project |
| `STAGING_CLOUDINARY_CLOUD_NAME`, `STAGING_CLOUDINARY_API_KEY`, `STAGING_CLOUDINARY_API_SECRET` | — | optional, a separate Cloudinary account/folder |
| `PUSHER_*`, `LIVEKIT_*`, `CLOUDINARY_*`, `TURN_*` | from `vercel.json` / dashboard | ignored in staging (`TURN_*` is only a relay and is harmless) |

## Local staging

```bash
cp .env.staging.example .env.staging   # fill in staging values (git-ignored)
npm run seed:staging                   # structure + test users + test data
npm run dev:staging                    # http://localhost:3001
```

`npm start` (production run) is unchanged.

Test logins (password `staging-test-123`, or `STAGING_TEST_PASSWORD`):
`test.manager` (dashboard), `test.member1`, `test.member2`. The seed also copies the app's normal
account list from code, as the production server does on every start. It does **not** copy any
production entries, attendance or task overrides.

## Promotion to production (later)

`npm run promote` (`scripts/promote-to-prod.sh`). It asks you to type `PROMOTE`, aborts on any
uncommitted change, merges `staging-v2` into `main`, pushes (Vercel then deploys the live domain),
and prints rollback steps. It does not touch any database or Vercel setting.
