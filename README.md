# Rank Orbit — SEO Team Progress Tracking

A premium, local-network team progress tracker for SEO agencies. No cloud services or API keys required — runs entirely on your local WiFi network.

Built by **Abdullah Saleem**

---

## Quick Start

```bash
npm install
node server.js
```

Open `http://<your-ip>:3000` on any device on the same network.

---

## Accounts

Passwords are not stored in this repository. They live only in MongoDB, hashed with bcrypt.
The manager changes passwords and adds members from the dashboard. A brand-new deployment can
create its first accounts from the `SEED_USER_PASSWORDS` environment variable (see `.env.example`).

---

## Pages

| URL          | Access       | Description                          |
|--------------|--------------|--------------------------------------|
| `/`          | Public       | Landing page                         |
| `/login`     | Public       | Username + password sign-in          |
| `/member`    | All roles    | Daily task entry portal              |
| `/dashboard` | Manager only | Spreadsheet, Analytics, Edit Tasks   |

---

## Task Types

Each task is assigned a type that determines how the member enters data:

| Type         | Input fields                              |
|--------------|-------------------------------------------|
| `links`      | Multi-row: Client name + links/count      |
| `layers`     | Multi-row: Client name + layer count      |
| `count`      | Single number input                       |
| `note`       | Free-text textarea                        |
| `count_note` | Number + notes textarea                   |
| `links_note` | Links/URL field + notes textarea          |

All task types support an optional **Section Note** (toggled via "+ Note" button).

---

## Dashboard Tabs

- **Spreadsheet** — 31-day rolling grid. Click any filled cell to expand the full entry.
- **Analytics** — Daily activity line chart + per-member submission rate bar chart.
- **Edit Tasks** — Add or remove tasks per member. Changes are saved as overrides; "Reset to Default" restores the original task list.

---

## Data Storage

All submission data is stored in `data.json` (flat JSON, no database). The file is keyed by username:

```json
{
  "ali.lodhi": {
    "2026-05-19": {
      "Guest Posting": { "rows": [{"client": "Acme", "value": "5"}], "total": 5, "sectionNote": "" }
    }
  },
  "_config": {
    "taskOverrides": {}
  }
}
```

Sessions last 30 days. Changing a member's password logs them out everywhere.

---

## Security Note

This tool is designed for **local network use only**. Do not expose port 3000 to the public internet without adding HTTPS and stronger authentication.
