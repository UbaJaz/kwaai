// Sends sign-in links through Resend's HTTP API (https://resend.com). Plain fetch, no SDK needed.
function resendSender({ apiKey, from }) {
  return async (to, link) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: 'Your Kwaai sign-in link',
        text: `Hi!\n\nUse this link to sign in to Kwaai. It works once and expires in 15 minutes:\n\n${link}\n\nDidn't ask for this? Just ignore this email.\n\nKwaai is an unofficial student project, not affiliated with any university.`,
        html: `<p>Hi!</p><p>Use this link to sign in to Kwaai. It works once and expires in 15 minutes:</p>
<p><a href="${link}" style="display:inline-block;background:#c8f169;color:#151d2b;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Sign in to Kwaai</a></p>
<p style="color:#5c6575;font-size:13px">Didn't ask for this? Just ignore this email.<br>Kwaai is an unofficial student project, not affiliated with any university.</p>`,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  };
}

module.exports = { resendSender };
