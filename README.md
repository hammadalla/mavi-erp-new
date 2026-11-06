# Mavi ERP — the real application

Working full-stack system: Node + Express + SQLite, two hard-separated faces, Arabic RTL,
branded with Mavi's real identity. No build step, no external services.

```
app/
├─ src/
│  ├─ schema.sql     all tables (SQLite, portable to Postgres)
│  ├─ db.js          connection + helpers + audit()
│  ├─ auth.js        two auth realms, scrypt passwords, OTP, guards
│  ├─ domain.js      status mapping, order numbering, money math, WhatsApp templates
│  ├─ server.js      /api/store/*  and  /api/admin/*   (32 endpoints)
│  └─ seed.js        demo data: styles, fabric, tailors, customers, 12 orders
├─ public/
│  ├─ store/         واجهة العميلة  (customer face)
│  ├─ admin/         لوحة الإدارة   (staff & owner)
│  └─ brand/         logo assets
└─ test/
   └─ api.test.js    49 permission + workflow assertions
```

## Run it

**Beginner?** Read **`docs/دليل-الاستخدام.md`** (Arabic) or **`docs/QUICKSTART.md`** (English) first.
Or just double-click `scripts/start-windows.bat` / `scripts/start-mac-linux.command` — it installs,
seeds and starts everything for you.

```bash
cd app
npm install                 # first time only
npm run seed                # creates data/mavi.db with realistic demo data
npm start                   # → http://localhost:3000
```

Handy scripts: `npm run reset` (wipe + re-seed), `npm test` (49 permission assertions).

Then open:

| URL | Who |
|---|---|
| `http://localhost:3000/store/` | Customer |
| `http://localhost:3000/admin/` | Staff & owner |

**Logins (seeded):**

| Role | Email | Password | Sees |
|---|---|---|---|
| Owner | `owner@mavi.eg` | `mavi-owner` | everything, including cost & profit |
| Staff | `staff@mavi.eg` | `mavi-staff` | orders, board, fabric, customers — **no money** |
| Customer | any phone, seeded example `01012345678` | 6-digit OTP | her own orders + her measurements |

In development the OTP is printed in the server console **and** returned as `dev_code`
so the UI can show it. Set `SHOW_OTP=0` to hide it once SMS/WhatsApp delivery is wired in.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (binds `0.0.0.0`) |
| `DB_PATH` | `./data/mavi.db` | SQLite file |
| `SHOW_OTP` | `1` | return the OTP in the API response (dev only) |
| `FORCE_SEED` | — | re-seed even if data exists |

## Tests

```bash
node test/api.test.js
```
Creates a throwaway DB, seeds it, boots the server on a test port and runs **49 assertions** —
the important ones being the permission wall:

- customer token → every `/api/admin/*` route returns **401**
- staff token → `/api/admin/money/*` returns **403**; orders/styles/fabric/tailors carry **no**
  `cost`, `profit`, `margin`, `cost_per_metre` or `rate_per_piece` fields
- staff cannot record a payment (403) and cannot set fabric/tailor costs (403)
- owner token → sees cost, profit, margin and all money routes
- one customer cannot read another customer's order (404)
- invalid colour / length / measurement rejected (400); order without measurements blocked (422)
- logout invalidates the token; a forged token is rejected

## How the wall is built (not just hidden buttons)

1. **Two auth realms.** `realm='store'` sessions belong to customers (phone + OTP);
   `realm='admin'` sessions belong to staff/owner (email + scrypt password).
   `resolve()` returns the realm, and every guard checks it — a customer token can never
   satisfy `requireStaff`.
2. **Role guards.** `requireStaff` (staff+owner) and `requireOwner` (owner only) wrap the routes;
   `/api/admin/money/*` is *entirely* behind `requireOwner`.
3. **Field-level stripping.** For staff, `cost`, `profit` and `margin` are deleted from the
   response objects server-side — the browser never receives them, so devtools can't reveal them.
4. **Row-level scoping.** Store queries always filter `customer_id = token.subject`.
   `/api/store/orders/:code` returns 404 for someone else's order, not 403.
5. **DTO projection.** `customerOrderView()` builds the customer payload from an allow-list —
   only names, colours, quantities, her price, her total. No cost, no workshop, no internal status.
6. **Status translation.** Internal `cut`/`sewing` both surface to the customer as
   «في التفصيل». Her labels live in one map in `domain.js`.
7. **Audit log.** Every status change, payment, production change and online order writes to
   `events` with actor and timestamp.

## What's implemented vs. next

**Done:** customer OTP auth, catalogue, product sheet with colours/lengths/sizes, measurement
capture, order placement with validation, her order tracking, staff/owner login, order list +
filters, order detail, status pipeline with auto-generated Arabic WhatsApp messages, fabric
deduction by metres, tailor assignment, cost & profit per order, payments, money summary,
outstanding balances, per-style revenue/margin report, colour demand report, printable workshop
sheet, dashboard KPIs, mobile layouts.

**Next (not in this slice):** SMS/WhatsApp OTP delivery, product photos, style create/edit UI,
stock decrement on delivery, courier integration (Bosta/Aramex), CSV/Excel export, Arabic PDF
invoices, daily DB backup, Postgres migration for production hosting.
