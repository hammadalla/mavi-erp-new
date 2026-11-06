#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
echo "============================================"
echo "  MAVI ERP  -  starting up"
echo "============================================"
echo
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is not installed."
  echo "    Install the LTS version from https://nodejs.org then run this file again."
  read -r -p "Press Enter to close..."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "[1/3] Installing packages - only the first time, may take a few minutes..."
  npm install || { echo "[!] npm install failed."; read -r -p "Press Enter..."; exit 1; }
else
  echo "[1/3] Packages already installed - skipping."
fi
if [ ! -f data/mavi.db ]; then
  echo "[2/3] Creating the database and demo data..."
  node src/seed.js
else
  echo "[2/3] Database found - keeping your existing data."
fi
echo "[3/3] Starting the server..."
echo
echo "   Admin panel (owner / staff): http://localhost:3000/admin/"
echo "   Customer page             : http://localhost:3000/store/"
echo
echo "   Logins: owner@mavi.eg / mavi-owner"
echo "           staff@mavi.eg / mavi-staff"
echo
echo "   Keep this window OPEN while using the program. Ctrl+C to stop."
echo "============================================"
echo
( sleep 2; (command -v open >/dev/null && open http://localhost:3000/admin/) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000/admin/) ) &
node src/server.js
