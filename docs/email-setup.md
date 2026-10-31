# Setting up Kwaai's email (and the legal bits that come with it)

For Jaswin. This gets real sign-in emails going to @myuct.ac.za addresses and sets up the contact address the privacy notice promises. Allow an evening: most of the time is waiting for DNS.

Never paste an API key into a chat, a commit, a screenshot or a code file. Keys go in Render's environment settings and a password manager, nowhere else.

## What you're setting up

- **A domain**, e.g. `kwaai.co.za`. Sign-in emails from your own domain land in myuct (Outlook) inboxes far more often than emails from a Gmail address sent through another service.
- **Brevo** sends the sign-in emails (code plus link). The free plan allows 300 emails a day. The app stops at 280 (`EMAIL_DAILY_CAP`) and tells students to try again tomorrow, so we never silently fail.
- **A contact address**, e.g. `hello@kwaai.co.za`, for privacy requests and removal requests. It can forward to your own inbox.

## 1. Turn on two-factor sign-in everywhere

Before anything else, turn on 2FA for GitHub, Render, Brevo and the domain registrar. Anyone who gets into one of these can read students' emails or send mail as Kwaai.

## 2. Get the domain

1. Buy the domain from a registrar that lets you edit DNS records. Any `.co.za` registrar does.
2. Register it in your own name or Ubayd's, not as "Kwaai": Kwaai isn't a company yet.
3. Turn on WHOIS privacy if the registrar offers it.

## 3. Set up Brevo

1. Sign up at [brevo.com](https://www.brevo.com) on the free plan, using an address we'll keep. Reading Brevo's terms and data-processing agreement is part of signing up. Save a copy (PDF) in our shared folder, because the privacy notice relies on it.
2. Go to **Senders, Domains & Dedicated IPs → Domains** and add the domain. Brevo shows several DNS records: a Brevo code (TXT), DKIM, and usually SPF and DMARC.
3. Add each record at the registrar exactly as Brevo shows it. If the registrar already has an SPF record (`v=spf1 ...`), add Brevo's `include:` to it instead of making a second SPF record.
4. If Brevo doesn't give you a DMARC record, add one yourself: a TXT record named `_dmarc` with the value `v=DMARC1; p=none; rua=mailto:hello@kwaai.co.za`. You can tighten `p=none` to `p=quarantine` once emails have been arriving fine for a few weeks.
5. Back in Brevo, click **Verify** or **Authenticate**. DNS can take from a few minutes to a few hours.
6. Under **Senders**, add `signin@kwaai.co.za` with the name `Kwaai`. A sender on an authenticated domain doesn't need its own inbox.
7. Under **SMTP & API → API keys**, generate a key called `render-kwaai`. Copy it into the password manager straight away, because Brevo shows it once.

Brevo moves menus around. If a name above doesn't match what you see, search Brevo's help for "authenticate domain" and "API key".

## 4. The contact address

Set up `hello@kwaai.co.za` (or whatever name you like) to forward to one of your inboxes. Many registrars offer free forwarding; ImprovMX is a free alternative. Send it a test email from outside.

This address goes on the privacy notice. Under POPIA we have to answer requests to see, correct or delete information. Removal requests promise a reply within 48 hours, so check it daily.

## 5. Put it on Render

In the Render dashboard, open the web service, then **Environment**, and set:

| Variable | Value |
|---|---|
| `BREVO_API_KEY` | the key from step 3 |
| `EMAIL_FROM` | `Kwaai <signin@kwaai.co.za>` |
| `BASE_URL` | `https://kwaai.onrender.com` (or the custom domain, once it points at Render) |
| `CONTACT_EMAIL` | `hello@kwaai.co.za` |
| `MODERATORS` | both our @myuct.ac.za addresses, comma-separated |
| `INFORMATION_OFFICER` | the one person named as information officer (see step 7), e.g. `Ubayd Hattas` |
| `DEMO_PASSWORD` | keep it while we're still building; remove it at launch |

If an email key is set without `EMAIL_FROM` and `BASE_URL`, the app refuses to start. That's on purpose: without `BASE_URL`, sign-in links could be built from a faked address.

Save, and let Render redeploy.

## 6. Test it

1. Open the site, sign in with your own @myuct.ac.za address and tick the 18+ box.
2. The email should arrive within a minute. Check **Junk** and **Other** too. If it's there, mark it "Not junk".
3. Try the 6-digit code once, then repeat with the "Sign in to Kwaai" button in a new email. Both should work.
4. In Brevo, check **Transactional → Logs** (or **Statistics**) to see whether the email was delivered or bounced.
5. Ask Ubayd to try from his account. Two different inboxes tell us much more than one.

If emails keep landing in junk, check the domain's records with an online SPF/DKIM/DMARC checker, and give the domain a week of normal use.

## 7. The legal side (POPIA)

None of this is legal advice. Before real students sign up, ask a lawyer to read `/privacy`, `/terms` and `/rules`. UCT's Law Clinic is a cheap place to start.

- **Information officer.** POPIA says a responsible party must have an information officer and register them with the Information Regulator. Pick one of us, set `INFORMATION_OFFICER`, and register through the Regulator's eServices portal ([inforegulator.org.za](https://inforegulator.org.za)). Ask the lawyer whether this applies to us as two individuals running a student project. If it does, do it before launch.
- **Processors.** Brevo (email) and Render (hosting) process students' data for us. Keep copies of their data-processing terms. If we add another service that touches personal data, update the "Who else sees it" section of `/privacy` first.
- **Under-18s.** The sign-in form makes students confirm they're 18 or older, because POPIA needs a guardian's consent for children. If we learn an account belongs to someone under 18, delete it from `/mod` and note it in the moderation log.
- **Requests.** Students can download and delete their own data from `/account`. Anything else that comes to the contact address (correct my data, object to processing) gets a reply within 30 days. Takedown requests get one within 48 hours.
- **Keep it minimal.** Don't add analytics, trackers or new fields about students without updating `/privacy` first.

## Before real launch (not yet)

- Move off Render's free plan to one with a persistent disk (about $7 a month). On the free plan the database is wiped whenever the app sleeps, so every account and review would vanish.
- Set `NODE_ENV=production` (secure cookies, no sample reviews) and remove `DEMO_PASSWORD`.
- Schedule `npm run backup` daily. It keeps 30 days of backups, which the privacy notice promises.
- Check that `TRUST_PROXY=1` matches Render's setup. The app doesn't log IPs, so this needs a temporary one-line log of `req.ip`: sign in from two networks (Wi-Fi and mobile data) and check you see two different IPs, then remove the log. If both show the same IP, rate limits would treat everyone as one person.
