# Quickstart (English)

**GitHub is storage for code — it does not run the program.** To use it you need Node.js on the
machine and one command. Here is the shortest path.

## 1. One-time install
- **Node.js LTS** → <https://nodejs.org> (next → next → finish). Verify: `node -v`
- The project folder: `mavi-erp/app`

## 2. Start it
**Easiest** — double-click:
- Windows: `scripts/start-windows.bat`
- macOS/Linux: `scripts/start-mac-linux.command` *(first time: right-click → Open)*

**Or manually** in the `app` folder:
```bash
npm install     # first time only
npm run seed    # creates data/mavi.db with demo data
npm start       # starts the server
```

Then open:
| URL | Who |
|---|---|
| <http://localhost:3000/admin/> | Owner & staff |
| <http://localhost:3000/store/> | Customer |

Keep the terminal window **open** while you use it. Close it (or Ctrl+C) to stop.

## 3. Logins
| Role | Email | Password |
|---|---|---|
| Owner (sees money) | `owner@mavi.eg` | `mavi-owner` |
| Staff (no money) | `staff@mavi.eg` | `mavi-staff` |
| Customer | any Egyptian mobile | 6-digit code shown on screen (dev) |

Log in as **owner**, look at «الفلوس», then log out and log in as **staff** — that page is gone
and the money block is locked. The server never sends those numbers to a staff account.

## 4. First real use
1. Change both passwords (`src/seed.js` holds the defaults — ask a developer, or edit the seeded users).
2. Wipe demo data: `npm run reset` (re-seeds), or delete `data/mavi.db` and `npm run seed`.
3. Enter your real styles, prices, fabrics (metres + cost/metre) and workshops (rate per piece).
4. Run 3 real orders end-to-end and print the workshop sheet.

## 5. Backups — the golden rule
Everything lives in **`data/mavi.db`**. Copy the `data` folder to a USB stick or Google Drive daily.
Lose that file and you lose every order, customer and measurement.

## 6. GitHub — when and why
Optional for local use. Use it to: keep an off-device copy, work from two devices, or **deploy**
(hosting providers pull code from GitHub).

Beginner route: GitHub account → **GitHub Desktop** → `Add Local Repository` → `app` →
`create a repository` → commit → **Publish repository**.

Never publish `data/mavi.db` (already in `.gitignore`) or real passwords.

## 7. Publishing online
This is a **server** (must run 24/7), so a static host won't work.

| Host | Cost | Note |
|---|---|---|
| **Render / Railway** | free to try, ~$5–7/mo | easiest: connect GitHub repo, `npm start` |
| **VPS** (Hetzner/DigitalOcean) | ~$5/mo | full control, more setup |
| **Vercel** | free | ⚠️ filesystem is not persistent — SQLite won't survive; needs an external DB |

Before going public: change passwords, wire real SMS/WhatsApp OTP and set `SHOW_OTP=0`,
attach a persistent disk for `data/`, and automate backups.

## 8. Troubleshooting
| Symptom | Fix |
|---|---|
| `node is not recognized` | Node.js not installed, or reopen the terminal after install |
| `npm install` fails | Check internet; delete `node_modules` and retry |
| Page won't load | Server window is closed — start it again |
| `EADDRINUSE` | Old copy still running; close it or `PORT=3001 npm start` |
| Money numbers missing | You're on a staff account — by design |
| Start fresh | `npm run reset` |
