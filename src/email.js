// Sends sign-in links through Resend's HTTP API (https://resend.com). Plain fetch, no SDK needed.
function resendSender({ apiKey, from }) {
  return async (to, link) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: 'Your LekkerOrNah sign-in link',
        text: `Hi!\n\nUse this link to sign in to LekkerOrNah. It works once and expires in 15 minutes:\n\n${link}\n\nDidn't ask for this? Just ignore this email.\n\nLekkerOrNah is an unofficial student project, not affiliated with UCT.`,
        html: `<p>Hi!</p><p>Use this link to sign in to LekkerOrNah. It works once and expires in 15 minutes:</p>
<p><a href="${link}" style="display:inline-block;background:#ff5a1f;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Sign in to LekkerOrNah</a></p>
<p style="color:#6f665b;font-size:13px">Didn't ask for this? Just ignore this email.<br>LekkerOrNah is an unofficial student project, not affiliated with UCT.</p>`,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  };
}

module.exports = { resendSender };
