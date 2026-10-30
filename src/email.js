// Sends sign-in emails over HTTP APIs with plain fetch, no SDK. HTTP rather than SMTP because Render's free plan
// blocks outbound SMTP ports.
// - Brevo (https://brevo.com): free for 300 emails a day, and works without a domain: verify one sender address.
// - Resend (https://resend.com): needs a verified domain before it can email students.

function message({ link, code }) {
  const subject = `Your Kwaai sign-in code: ${code}`;
  const text = `Your Kwaai sign-in code is ${code}\n\nType it on the sign-in page, or open this link:\n${link}\n\nBoth work once and expire in 15 minutes. Didn't ask for this? Ignore this email.\n\nKwaai is an unofficial student project, not affiliated with any university.`;
  const html = `<p>Your Kwaai sign-in code is</p>
<p style="font:700 32px/1 ui-monospace,Menlo,monospace;letter-spacing:6px;color:#151d2b;margin:8px 0 20px">${code}</p>
<p>Type it on the sign-in page, or use this button:</p>
<p><a href="${link}" style="display:inline-block;background:#c8f169;color:#151d2b;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Sign in to Kwaai</a></p>
<p style="color:#5c6575;font-size:13px">Both work once and expire in 15 minutes. Didn't ask for this? Ignore this email.<br>Kwaai is an unofficial student project, not affiliated with any university.</p>`;
  return { subject, text, html };
}

// "Kwaai <signin@example.com>" -> { name: 'Kwaai', email: 'signin@example.com' }
function parseFrom(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return m ? { name: m[1] || 'Kwaai', email: m[2] } : { name: 'Kwaai', email: String(from || '').trim() };
}

function brevoSender({ apiKey, from }) {
  const sender = parseFrom(from);
  return async (to, details) => {
    const { subject, text, html } = message(details);
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  };
}

function resendSender({ apiKey, from }) {
  return async (to, details) => {
    const { subject, text, html } = message(details);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  };
}

// Brevo if its key is set, otherwise Resend, otherwise nothing (dev mode then shows the link on screen).
function senderFromEnv(env) {
  if (env.BREVO_API_KEY) return brevoSender({ apiKey: env.BREVO_API_KEY, from: env.EMAIL_FROM });
  if (env.RESEND_API_KEY) return resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  return null;
}

module.exports = { brevoSender, resendSender, senderFromEnv, parseFrom, message };
