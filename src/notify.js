'use strict';
/* Outbound messages (login codes / WhatsApp notifications).
   Works with no configuration at all: falls back to "the brand sends it manually".
   Fill these env vars later to make it automatic — nothing else changes:
     TWILIO_SID, TWILIO_TOKEN, TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
*/
const { get } = require('./db');

const SID = process.env.TWILIO_SID;
const TOKEN = process.env.TWILIO_TOKEN;
const FROM = process.env.TWILIO_WHATSAPP_FROM;

const enabled = !!(SID && TOKEN && FROM);

async function sendCode(phone, code) {
  if (!enabled) return { sent: false, channel: 'brand' };   // owner sends it from the dashboard
  const to = 'whatsapp:+2' + phone.replace(/^0/, '');
  const body = new URLSearchParams({
    To: to,
    From: FROM,
    Body: `كود الدخول لـ Mavi: ${code}\nصالح ٥ دقايق. متشاركيهوش مع حد.`,
  });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!r.ok) {
      console.warn('[notify] WhatsApp send failed:', r.status, await r.text().catch(() => ''));
      return { sent: false, channel: 'brand' };
    }
    return { sent: true, channel: 'whatsapp' };
  } catch (e) {
    console.warn('[notify] WhatsApp error:', e.message);
    return { sent: false, channel: 'brand' };
  }
}

module.exports = { sendCode, enabled };
