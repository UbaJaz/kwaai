// Automatic screening for review comments.
// "reject" = the student must edit before posting. "hold" = posted only after a moderator approves it.
// shortcut: keyword lists catch the obvious cases only; add an ML/LLM classifier once real traffic shows what slips through.

const REJECT = [
  { reason: 'Contains an email address', re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { reason: 'Contains a phone number', re: /(\+?\d[\s-]?){9,}/ },
  { reason: 'Contains a link', re: /https?:\/\/|www\.|\.(com|co\.za|net|org)\b/i },
];

const HOLD = [
  {
    reason: 'Possible allegation (needs proof, so a moderator checks it)',
    re: /\b(racis[mt]\w*|sexis[mt]\w*|harass\w*|assault\w*|abus\w*|rape\w*|corrupt\w*|bribe\w*|steal\w*|stole|fraud\w*|drunk|high on|affair|sleeps? with|illegal\w*|criminal|discriminat\w*|bully\w*|predator\w*|creep\w*)\b/i,
  },
  {
    reason: 'Comment about appearance or personal life',
    re: /\b(ugly|fat|hot|sexy|smells?|smelly|bald|old man|old lady|wife|husband|girlfriend|boyfriend|divorce\w*|pregnan\w*|religio\w*|accent)\b/i,
  },
  {
    reason: 'Strong language or insult',
    re: /\b(f+u+c+k\w*|shit\w*|bitch\w*|bastard\w*|asshole\w*|dick\w*|cunt\w*|kak|poes\w*|doos|moer\w*|idiot\w*|stupid|moron\w*|retard\w*|useless|incompetent|clown|trash|garbage|worst human|hate (him|her|them))\b/i,
  },
  {
    reason: 'Mentions race, gender or other identity',
    re: /\b(black|white|coloured|indian|asian|african|jew\w*|muslim\w*|christian\w*|gay|lesbian|trans\w*|female|male|woman|women|man\b|men\b)\b/i,
  },
];

function screenComment(body) {
  const text = String(body || '');
  const rejected = REJECT.filter((r) => r.re.test(text)).map((r) => r.reason);
  if (rejected.length) return { action: 'reject', reasons: rejected };
  const held = HOLD.filter((r) => r.re.test(text)).map((r) => r.reason);
  if (held.length) return { action: 'hold', reasons: held };
  return { action: 'publish', reasons: [] };
}

// Reasons serious enough to hide a review the moment one person reports it.
const REPORT_REASONS = [
  { key: 'defamation', label: 'False claim or allegation about a real person', hideNow: true },
  { key: 'private', label: 'Shares private or personal information', hideNow: true },
  { key: 'discrimination', label: 'Discriminatory or hateful', hideNow: true },
  { key: 'attack', label: 'Personal attack, not about teaching', hideNow: false },
  { key: 'spam', label: 'Spam or not a real review', hideNow: false },
  { key: 'other', label: 'Something else', hideNow: false },
];
// Any other reason hides the review once this many open reports pile up.
const HIDE_AFTER_REPORTS = 2;

module.exports = { screenComment, REPORT_REASONS, HIDE_AFTER_REPORTS };
