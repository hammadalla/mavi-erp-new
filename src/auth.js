'use strict';
/* Two auth realms, deliberately separate:
     realm 'store'  → customers (phone + password; WhatsApp code as fallback)
     realm 'admin'  → staff / owner (email + password)
   A store token can never satisfy an admin guard, and vice versa. */
const crypto = require('crypto');
const { get, run, all } = require('./db');

const SESSION_DAYS = 14;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ---------- password hashing (scrypt, no external deps) ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

/* ---------- customer password login throttling ---------- */
const attempts = new Map();   // phone -> {n, until}
const LOCK_AFTER = 6, LOCK_MS = 10 * 60 * 1000;
const MAX_ATTEMPT_KEYS = 10000;
const ATTEMPT_SWEEP_EVERY = 128;
let attemptsSinceSweep = 0;

function recordFailure(map, key, lockMs) {
  const now = Date.now();
  const previous = map.get(key);
  const attempt = previous && now <= previous.until ? previous : { n: 0 };
  attempt.n += 1;
  attempt.until = now + lockMs;
  map.delete(key);
  map.set(key, attempt);

  attemptsSinceSweep += 1;
  if (attemptsSinceSweep >= ATTEMPT_SWEEP_EVERY || map.size > MAX_ATTEMPT_KEYS) {
    attemptsSinceSweep = 0;
    for (const [candidate, value] of map) {
      if (now > value.until) map.delete(candidate);
    }
  }
  while (map.size > MAX_ATTEMPT_KEYS) {
    map.delete(map.keys().next().value);
  }
}

function throttled(phone) {
  const a = attempts.get(phone);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(phone); return false; }
  return a.n >= LOCK_AFTER;
}
function noteFailure(phone) {
  recordFailure(attempts, phone, LOCK_MS);
}
function clearFailures(phone) { attempts.delete(phone); }

/* ---------- owner/staff lockout (separate key space) ---------- */
const adminAttempts = new Map();
const ADMIN_LOCK_MS = 15 * 60 * 1000;
function adminThrottled(email) {
  const a = adminAttempts.get(email);
  if (!a) return false;
  if (Date.now() > a.until) { adminAttempts.delete(email); return false; }
  return a.n >= 8;
}
function adminFailure(email) {
  recordFailure(adminAttempts, email, ADMIN_LOCK_MS);
}
function adminClear(email) { adminAttempts.delete(email); }

/* ---------- "keep me signed in" ----------
   A phone that stays logged in for months is how you actually use this daily,
   so the session lives longer and the cookie carries it into the installed app. */
function createSession(realm, subjectId, role, days) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + (days || SESSION_DAYS) * 864e5).toISOString();
  run('INSERT INTO sessions(token_hash,realm,subject_id,role,expires_at) VALUES(?,?,?,?,?)',
      sha256(token), realm, subjectId, role, expires);
  return { token, expires };
}

/* ---------- sessions ---------- */
const SESSION_COOKIE = 'mavi_session';
function setSessionCookie(res, token, days) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: (days || 30) * 864e5,
  });
}
function clearSessionCookie(res) { res.clearCookie(SESSION_COOKIE, { path: '/' }); }

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}
function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)mavi_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function resolve(token) {
  if (!token) return null;
  const row = get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    run('DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
    return null;
  }
  return row;
}

/* ---------- guards ---------- */
function attachUser(req, _res, next) {
  const token = readToken(req);
  req.session = resolve(token);
  req.token = token;
  req.user = null;
  if (req.session && req.session.realm === 'store') {
    req.user = get('SELECT id, phone, name, area FROM customers WHERE id = ?', req.session.subject_id) || null;
    if (!req.user) req.session = null;
  }
  if (req.session && req.session.realm === 'admin') {
    req.user = get('SELECT id, email, name, role FROM users WHERE id = ? AND active = 1', req.session.subject_id) || null;
    if (!req.user) req.session = null;
  }
  next();
}

/** store realm: any logged-in customer */
function requireCustomer(req, res, next) {
  if (!req.session || req.session.realm !== 'store' || !req.user)
    return res.status(401).json({ error: 'login_required', message: 'محتاجة تسجّلي دخول الأول' });
  next();
}

/** admin realm: staff or owner */
function requireStaff(req, res, next) {
  if (!req.session || req.session.realm !== 'admin' || !req.user)
    return res.status(401).json({ error: 'login_required', message: 'Admin login required' });
  if (!['owner', 'staff'].includes(req.user.role))
    return res.status(403).json({ error: 'forbidden' });
  next();
}

/** admin realm: owner only — cost, margin, profit, expenses, reports */
function requireOwner(req, res, next) {
  if (!req.session || req.session.realm !== 'admin' || !req.user)
    return res.status(401).json({ error: 'login_required', message: 'Admin login required' });
  if (req.user.role !== 'owner')
    return res.status(403).json({ error: 'forbidden', message: 'الأرقام المالية للإدارة العليا فقط' });
  next();
}

/* ---------- OTP ---------- */
const OTP_TTL_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;

function issueOtp(phone) {
  // throttle: max 3 codes per phone per 15 minutes
  const recent = get(`SELECT COUNT(*) n FROM otp_codes
                      WHERE phone = ? AND created_at > datetime('now','-15 minutes')`, phone).n;
  if (recent >= 3) {
    const err = new Error('too_many_requests');
    err.status = 429;
    throw err;
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  run('INSERT INTO otp_codes(phone,code_hash,expires_at) VALUES(?,?,datetime(\'now\', ?))',
      phone, sha256(code), `+${OTP_TTL_MIN} minutes`);
  return code;
}

/* Issue a code for a phone that already has an account (forgotten password).
   The owner can read the newest unused code from the dashboard. */
function latestCodeFor(phone) {
  return get(`SELECT * FROM otp_codes WHERE phone = ? AND used = 0
              AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`, phone);
}

function consumeOtp(phone, code) {
  const row = get(`SELECT * FROM otp_codes WHERE phone = ? AND used = 0
                   ORDER BY id DESC LIMIT 1`, phone);
  if (!row) return { ok: false, reason: 'no_code' };
  if (new Date(row.expires_at + 'Z') < new Date()) return { ok: false, reason: 'expired' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
  if (sha256(code) !== row.code_hash) {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return { ok: false, reason: 'wrong_code' };
  }
  run('UPDATE otp_codes SET used = 1 WHERE id = ?', row.id);
  return { ok: true };
}

function pruneExpired() {
  run("DELETE FROM sessions WHERE expires_at < datetime('now')");
  run("DELETE FROM otp_codes WHERE expires_at < datetime('now','-1 day')");
}

module.exports = { latestCodeFor, throttled, noteFailure, clearFailures,
                   adminThrottled, adminFailure, adminClear, setSessionCookie,
  hashPassword, verifyPassword, createSession, destroySession, readToken,
  attachUser, requireCustomer, requireStaff, requireOwner,
  issueOtp, consumeOtp, pruneExpired, sha256,
};
