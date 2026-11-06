-- Mavi ERP — schema (SQLite / portable to Postgres)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- people ----------
-- staff & owner accounts (the /admin realm)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','staff')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- customers (the /store realm) — a completely separate auth realm
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  area       TEXT,
  notes      TEXT,
  password_hash TEXT,                      -- customers sign in with phone + password
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS measurements (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  waist  INTEGER, hip INTEGER, bust INTEGER,
  length INTEGER, sleeve INTEGER, arm INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one-time codes for customer login
CREATE TABLE IF NOT EXISTS otp_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, created_at DESC);

-- sessions for both realms
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  realm      TEXT NOT NULL CHECK (realm IN ('store','admin')),
  subject_id INTEGER NOT NULL,
  role       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- catalogue ----------
CREATE TABLE IF NOT EXISTS styles (
  id        TEXT PRIMARY KEY,             -- SK-01, AB-07 …
  name      TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('made','stock')),
  price     REAL NOT NULL,                -- selling price
  cost      REAL NOT NULL DEFAULT 0,      -- OWNER ONLY (never sent to /store)
  lead_days INTEGER NOT NULL DEFAULT 7,
  note      TEXT,
  active    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS style_colours (
  style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  hex      TEXT,
  sort     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (style_id, name)
);

CREATE TABLE IF NOT EXISTS style_lengths (
  style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  cm       INTEGER NOT NULL,
  PRIMARY KEY (style_id, cm)
);

CREATE TABLE IF NOT EXISTS style_sizes (
  style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  size     TEXT NOT NULL,
  PRIMARY KEY (style_id, size)
);

CREATE TABLE IF NOT EXISTS fabric (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  colour          TEXT,
  metres          REAL NOT NULL DEFAULT 0,
  cost_per_metre  REAL NOT NULL DEFAULT 0,
  reorder_level   REAL NOT NULL DEFAULT 4,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tailors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  phone          TEXT,
  rate_per_piece REAL NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  style_id   TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  size       TEXT,
  colour     TEXT,
  qty        INTEGER NOT NULL DEFAULT 0,
  buy_price  REAL NOT NULL DEFAULT 0,
  sell_price REAL NOT NULL DEFAULT 0
);

-- ---------- orders ----------
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,       -- MV-YYMM-NNN
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  channel     TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp|facebook|instagram|online|walkin
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','confirmed','cut','sewing','ready','delivered','cancelled')),
  promise_date TEXT,
  delivery_fee REAL NOT NULL DEFAULT 0,
  discount     REAL NOT NULL DEFAULT 0,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  style_id    TEXT NOT NULL REFERENCES styles(id),
  qty         INTEGER NOT NULL DEFAULT 1,
  colour      TEXT,
  length_cm   INTEGER,
  size        TEXT,
  unit_price  REAL NOT NULL,
  fabric_id   INTEGER REFERENCES fabric(id),
  metres_used REAL NOT NULL DEFAULT 0,
  tailor_id   INTEGER REFERENCES tailors(id),
  unit_cost   REAL NOT NULL DEFAULT 0,    -- snapshot of material + labour cost
  status      TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount     REAL NOT NULL,
  method     TEXT NOT NULL DEFAULT 'cash',
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  category  TEXT NOT NULL,
  amount    REAL NOT NULL,
  note      TEXT,
  spent_on  TEXT NOT NULL
);

-- audit trail for anything that touches money or status
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  actor      TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity, entity_id);


-- Customer custom requests and their private images.
CREATE TABLE IF NOT EXISTS custom_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
 date_needed TEXT, details TEXT NOT NULL DEFAULT '', measurements TEXT NOT NULL DEFAULT '{}',
 image BLOB NOT NULL, image_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 status TEXT NOT NULL DEFAULT 'review', price REAL, deposit_percent REAL, advice TEXT NOT NULL DEFAULT '',
 payment_details TEXT NOT NULL DEFAULT '', receipt BLOB, receipt_type TEXT, payment_method TEXT,
 confirmed_at TEXT
);

-- Deposits for catalogue orders. Receipt images remain private in the database backup.
CREATE TABLE IF NOT EXISTS order_deposits (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
 percent REAL, payment_details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'needs_quote',
 receipt BLOB, receipt_type TEXT, payment_method TEXT, confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS item_cost_lines (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
 label TEXT NOT NULL, quantity REAL NOT NULL, unit_cost REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_order_links (
 request_id INTEGER PRIMARY KEY REFERENCES custom_requests(id) ON DELETE CASCADE,
 order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS stock_reservations (
 order_item_id INTEGER PRIMARY KEY REFERENCES order_items(id),
 stock_id INTEGER NOT NULL REFERENCES stock_items(id),
 qty INTEGER NOT NULL CHECK(qty > 0),
 released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1))
);
CREATE TABLE IF NOT EXISTS stock_movements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 stock_id INTEGER NOT NULL REFERENCES stock_items(id), delta INTEGER NOT NULL,
 reason TEXT NOT NULL, actor TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Private, persistent in-account notifications for order status changes.
CREATE TABLE IF NOT EXISTS customer_notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 status TEXT NOT NULL,
 message TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_customer ON customer_notifications(customer_id,read_at,id);

-- Public tailoring catalogue media and customer-facing fabric descriptions.
CREATE TABLE IF NOT EXISTS style_images (
 id INTEGER PRIMARY KEY AUTOINCREMENT, style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
 image BLOB NOT NULL, image_type TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS style_fabrics (
 style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE, name TEXT NOT NULL,
 PRIMARY KEY(style_id,name)
);

-- Additional customer reference images; the first remains in custom_requests for compatibility.
CREATE TABLE IF NOT EXISTS custom_request_images (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id INTEGER NOT NULL REFERENCES custom_requests(id) ON DELETE CASCADE,
 image BLOB NOT NULL, image_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS style_sections (style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE, section TEXT NOT NULL, trend_year INTEGER, PRIMARY KEY(style_id,section));
CREATE TABLE IF NOT EXISTS service_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT 'عميلة MAVI', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
