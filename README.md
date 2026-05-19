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

## Credentials

### Management Access
| Username    | Password  | Role      | Access               |
|-------------|-----------|-----------|----------------------|
| `manager`   | `mgr2024` | Manager   | Full dashboard       |
| `assistant` | `asst2024`| Assistant | Full dashboard       |

### Team Members
| Username         | Password    | Display Name      |
|------------------|-------------|-------------------|
| `ali.lodhi`      | `ali@123#RO`    | Ali Lodhi         |
| `abida.khalid`   | `abida@123#RO`  | Abida Khalid      |
| `syed.salman`    | `salman@123#RO` | Syed Salman Ali   |
| `usman.tariq`    | `usman@123#RO`  | Usman Tariq       |
| `abdullah.asif`  | `asif@123#RO`   | Abdullah Asif     |
| `abdullah.gull`  | `gull@123#RO`   | Abdullah Gull     |
| `rizwan.haider`  | `rizwan@123#RO` | Rizwan Haider     |
| `haseeb.ahmed`   | `haseeb@123#RO` | Haseeb Ahmed      |
| `sana.effat`     | `sana@123#RO`   | Sana Effat        |
| `m.kashif`       | `kashif@123#RO` | Muhammad Kashif   |
| `sajid.saleem`   | `sajid@123#RO`  | Sajid Saleem      |
| `toseef.ahmed`   | `toseef@123#RO` | Toseef Ahmed      |
| `ahmad.rehman`   | `ahmad@123#RO`  | Ahmad Rehman      |
| `naveed.liaqat`  | `naveed@123#RO` | Naveed Liaqat     |
| `abler.khan`     | `abler@123#RO`  | Abler Khan        |
| `ali.raza`       | `raza@123#RO`   | Ali Raza          |

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

To change passwords or add users, edit the `USERS` object at the top of `server.js`. Sessions last 8 hours.

---

## Security Note

This tool is designed for **local network use only**. Do not expose port 3000 to the public internet without adding HTTPS and stronger authentication.
