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
| Front end | Plain HTML/CSS/JS in `public/`, Chart.js for charts, Inter Tight + Geist Mono fonts (monochrome look in `design-system.css`) |

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
- **Team members** use the Member Portal. Records are theirs to create, not to change:
  - they fill and update **today's** tasks (and yesterday's while a night shift that started
    yesterday is still open); past and future days are read-only;
  - attendance (start, break, resume, end) is stamped with the **server clock** in the team
    time zone (`APP_TIMEZONE`, default Asia/Karachi) — the browser's time is never used;
  - they cannot edit attendance times or past attendance notes, nor add, rename or retarget
    tasks or change targets, nor change their name, shift or password (they can add a
    client while logging; it is marked new for the manager). The manager corrects records from the
    dashboard (attendance edits keep an edit history).
  - when something is wrong they press **Request a correction** (on a locked day, or under
    My Day for attendance). The request shows first in the manager's **Needs Attention**; the
    manager opens that day, fixes it and marks it corrected or declined with a reply, which the
    member sees in My History straight away. At most 10 open requests per member.
- A brand-new deployment can create its first accounts from the `SEED_USER_PASSWORDS`
  environment variable (see `.env.example`).

---

## Pages

| URL                       | Who            | What                                                     |
|---------------------------|----------------|----------------------------------------------------------|
| `/`                       | Everyone       | Homepage with live team numbers                          |
| `/login`                  | Everyone       | Sign in                                                  |
| `/member`                 | Team members   | My Space: My Day (attendance timer), Log Work (task · client · how many, auto-save), Note for Manager |
| `/member/history`         | Team members   | My History: My Week, tasks and attendance (last 30 days) |
| `/dashboard`              | Manager, assistant | Today: KPIs, Needs Attention, each member's work so far task by task |
| `/dashboard/month`        | Manager, assistant | Month: team scores vs last month; click a member for the day-by-day and task report |
| `/dashboard/team`         | Manager, assistant | Team table; `/dashboard/team/<username>` is a member profile |
| `/dashboard/work`         | Manager, assistant | Monthly task grid per member, edit entries, CSV       |
| `/dashboard/attendance`   | Manager, assistant | Day, Month and Member views, edit with history, CSV  |
| `/dashboard/assignments`  | Manager, assistant | Assignments: task library × members; give, retarget, move or remove a task from a date |
| `/dashboard/clients`      | Manager, assistant | Clients: the shared client list and each client's work for a month |
| `/dashboard/reports`      | Manager, assistant | Reports for a week, month or custom range, CSV        |
| `/dashboard/settings`     | Manager, assistant | Team accounts                                         |

---

## Work log: task · client · how many

Every piece of work is one line: **which task, for which client, how many** (links, posts,
audits… — each task has its own unit). The member picks the task and the client (typing
searches the shared client list), types the number and presses Enter; the task stays selected
for the next client. Lines can be changed or removed for today; "Same clients as last working
day" copies yesterday's clients. A client that is not in the list yet is added and marked
**new** for the manager. A notes task (no number) is a plain text box.

Lines are stored in the day's entry under the task's ID, as `rows: [{ client, clientId, value }]`
with a `total`. Older entries keep their shapes (`{ value }`, `{ links, text }` …) and every
reader counts by shape, so old and new days add up the same way.

**Assignments.** A task in the library (name, unit, group) is given to a member with a daily
target, from a date: today, tomorrow or the start of next month. Changes can't start in the
past. Each change is kept as a dated assignment row (`assignments`), so a target change or a
task moving to someone else never rewrites earlier days. Every task has a permanent ID:
renaming never hides old entries. "Copy tasks to a teammate" gives a new member someone's
tasks and targets.

**Scores.** A day's target % = the average of the member's targeted tasks, each capped at
100%. The month score = work done ÷ (that day's target × days present), each task capped at
100%, so extra work on one task can't hide a missed one. Tasks that aren't done every day are
judged over the month. Month compares with the previous month (score and daily averages).

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
| `clients`     | The shared client list (`fromTeam` = added by a member, unchecked) |
| `assignments` | Member · task · daily target · from / to dates                   |
| `assignlogs`  | The Assignments page's change list                               |
| `corrections` | Members' correction requests and the manager's answers           |
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
