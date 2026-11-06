# Deploy Mavi ERP — cheapest path that is actually stable

## Option A — one command on any VPS (free forever on Oracle Cloud)
```bash
# on a fresh Ubuntu 22/24 server, as root
apt update && apt install -y docker.io docker-compose-v2
git clone https://github.com/<your-user>/MAVI-ERP.git && cd MAVI-ERP/app
docker compose -f deploy/docker-compose.yml up -d --build
```
Then open `http://<server-ip>/admin/` — log in, change the password, download a backup.

**HTTPS for free without owning a domain:** use `sslip.io`. If the server IP is
`141.147.20.5`, the site is reachable at `https://141-147-20-5.sslip.io/` and Caddy
will fetch a real Let's Encrypt certificate for it automatically.

Set the public link in the app to that address (النسخ والأمان → لينك العميلات).

## Option B — Northflank free plan (2 services, persistent volume, no sleep)
1. Create a **Service** from your GitHub repo — it detects the `Dockerfile`.
2. Add a **Persistent Volume** mounted at `/data`.
3. Environment: `DB_PATH=/data/mavi.db`, `SHOW_OTP=0`, `NODE_ENV=production`.
4. Port: `3000`, protocol HTTP, and expose it publicly.

## Option C — Render free (easiest, with a caveat)
Works with no card, but the free instance has **no persistent disk**: the database lives
in memory of the disk-less container and is **wiped on every deploy or restart**.
Use it to *show* the shop to someone, never to keep real orders.

## Backups are the safety net
Whether free or paid: **النسخ والأمان → نزّلي نسخة احتياطية** every day, and keep the file
on Google Drive. A restored file brings back every order, measurement and price.
