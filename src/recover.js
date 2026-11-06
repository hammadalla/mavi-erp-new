'use strict';
/* Emergency password reset — for when nobody can log in.
   Usage (in the host's Shell/Console tab):
       node src/recover.js owner@mavi.eg "MyNewPassword123"
   Works on whatever DB_PATH the service uses. */
const { get, run } = require('./db');
const { hashPassword } = require('./auth');

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.log('Usage: node src/recover.js <email> <new-password>');
  console.log('\nUsers in this database:');
  for (const u of require('./db').all('SELECT email, role FROM users')) {
    console.log(`  ${u.email}  (${u.role})`);
  }
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const user = get('SELECT * FROM users WHERE email = ?', email.trim().toLowerCase());
if (!user) {
  console.error('No such user:', email);
  console.log('Existing:', require('./db').all('SELECT email FROM users').map(u => u.email).join(', '));
  process.exit(1);
}

run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
require('./db').audit('user', user.id, 'password_reset_cli', 'cli');
console.log(`✓ Password updated for ${user.email} (${user.role}). Log in again now.`);
