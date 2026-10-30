# Rank Orbit — SEO Team Progress Tracking

An internal web app for an SEO agency: team members log their daily tasks and
attendance, and the manager sees progress, targets and reports in one place.

Built by **Abdullah Saleem**

---

## Stack

| Part      | What we use                                                        |
|-----------|--------------------------------------------------------------------|
| Server    | Node.js + Express (`server.js`, helpers in `lib/`)                 |
| Database  | MongoDB (Atlas) through Mongoose; sessions stored with connect-mongo |
| Hosting   | Vercel (`vercel.json`) — production from `main`, previews from other branches |
| Front end | Plain HTML/CSS/JS in `public/`, Chart.js for charts, Plus Jakarta Sans + Inter fonts |

Passwords are hashed with bcrypt. No passwords or secrets are stored in this repository.

---

## Running it locally

```bash
npm install
cp .env.example .env      # then fill in MONGODB_URI and SESSION_SECRET
npm start                 # http://localhost:3000
```

Environment variables are listed (names only) in `.env.example`. Production values live in
the Vercel project settings.

For a throw-away local copy with test data only, use the staging setup instead
(`npm run dev:staging`, `npm run seed:staging`) — see `STAGING.md`.

---

## Accounts

- The **manager** adds team members, resets passwords, deactivates or removes accounts
  from **Settings**. Resetting a password signs that person out on every device.
- **Assistants** use the manager dashboard and can reset member passwords, but cannot add,
  deactivate or remove accounts.
- **Team members** use the Member Portal.
- A brand-new deployment can create its first accounts from the `SEED_USER_PASSWORDS`
  environment variable (see `.env.example`).

---

## Pages

| URL                       | Who            | What                                                     |
|---------------------------|----------------|----------------------------------------------------------|
| `/`                       | Everyone       | Homepage with live team numbers                          |
| `/login`                  | Everyone       | Sign in                                                  |
| `/member`                 | Team members   | My Space: My Day (attendance timer), today's tasks with auto-save, Note for Manager |
| `/member/history`         | Team members   | My History: My Week, tasks and attendance (last 30 days) |
| `/dashboard`              | Manager, assistant | Overview: KPIs, Needs Attention, team at a glance    |
| `/dashboard/team`         | Manager, assistant | Team table; `/dashboard/team/<username>` is a member profile |
| `/dashboard/work`         | Manager, assistant | Monthly task grid per member, edit entries, CSV       |
| `/dashboard/attendance`   | Manager, assistant | Day, Month and Member views, edit with history, CSV  |
| `/dashboard/tasks`        | Manager, assistant | Tasks & Targets: per member, or all tasks with multi-assign |
| `/dashboard/reports`      | Manager, assistant | Reports for a week, month or custom range, CSV        |
| `/dashboard/settings`     | Manager, assistant | Team accounts                                         |

---

## Tasks

Every task has a permanent ID, so renaming a task never hides old entries. One task can be
assigned to many team members, and each task can have a **daily target**, which drives the
target % shown on Overview, Team, Reports and My Space.

| Type          | What the team member fills in                    |
|---------------|--------------------------------------------------|
| Number        | One number                                       |
| Links List    | Rows of client + number of links (auto total)    |
| Layers List   | Rows of client + number of layers (auto total)   |
| Number + Note | A number and a short note                        |
| Links + Note  | Pasted links (each link counts) and a note       |
| Text Note     | Free text (no target)                            |

Every task also has an optional note ("+ Note").

---

## Live updates

Whatever the manager changes for a member — tasks, targets, entries, attendance, name — shows
on that member's open My Space within about 10 seconds, without a reload, even when the
manager and the member reach different server instances. Each change bumps the member's
revision (`users.rev`); the portal checks `/api/my/rev` every 10 s while the tab is visible
(and as soon as it is shown again) and updates in place, never touching a card the member
is typing in. Saves are per task, so the manager and the member editing the same day never
overwrite each other's other tasks.

## Data

All data is in MongoDB:

| Collection    | Holds                                                            |
|---------------|------------------------------------------------------------------|
| `users`       | Accounts (hashed passwords, role, shift, active)                 |
| `tasks`       | Task definitions, targets and who they are assigned to           |
| `entries`     | One document per member per day, values keyed by task ID         |
| `attendances` | One document per member per day: sessions, breaks, edit history  |
| `membernotes` | The manager's private notes about a member                       |
| `configs`     | Small settings and one-time migration records                    |

---

## Before promoting V2 to production

The first V2 start converts old entries (keyed by task name) to task IDs, once, after
backing up the old collections. Rehearse it on a **copy** of the production database first —
the script only reads:

```bash
MONGODB_URI="<copy of the production database>" node scripts/migration-dry-run.js
```

It must end with "✓ Every old value maps to a task. Safe to promote." Then run
`npm run promote` (it asks you to confirm the rehearsal passed).

After launch, Settings marks accounts that still use their original password (the one that
was written in the old code); reset those.

## What changed in V2

- **Screen monitoring was removed.** There is no screen sharing, no screenshots and no
  monitoring prompt anywhere in the app.
- New design (light and dark themes), new manager pages (Overview, Team, Reports, Settings)
  and the new Member Portal (My Space).
- Tasks moved to permanent task IDs with daily targets and multi-assign.
- Passwords are hashed; old plain-text passwords are converted on first start.
