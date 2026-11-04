// Universities Kwaai covers or plans to cover. Each one gets an accent colour used in a few small
// places (the band under the header, the university picker, labels and course codes) while the
// Kwaai brand itself stays the same. The accents are our own picks that echo each campus, not
// official university brand values, and no crests or logos are used. Every accent must be dark
// enough for text on white (checked in the tests).
const UNIVERSITIES = [
  { slug: 'uct', short: 'UCT', name: 'University of Cape Town', city: 'Cape Town', accent: '#0b3c5d', soft: '#e3ecf2', live: true, emailDomain: 'myuct.ac.za', staffDomain: 'uct.ac.za' },
  { slug: 'wits', short: 'Wits', name: 'University of the Witwatersrand', city: 'Johannesburg', accent: '#7a5c00', soft: '#f6efd9', live: false },
  { slug: 'up', short: 'UP', name: 'University of Pretoria', city: 'Pretoria', accent: '#9b1c2c', soft: '#f8e4e6', live: false },
  { slug: 'uj', short: 'UJ', name: 'University of Johannesburg', city: 'Johannesburg', accent: '#b4441a', soft: '#fbe9e0', live: false },
  { slug: 'su', short: 'Stellenbosch', name: 'Stellenbosch University', city: 'Stellenbosch', accent: '#61223b', soft: '#f3e6eb', live: false },
];

// Only UCT has data so far, so every page uses it.
const CURRENT = UNIVERSITIES.find((u) => u.slug === 'uct');

// Who an email belongs to: a live university and whether it's a student or a staff address, or null. Students and
// staff have separate domains (at UCT, @myuct.ac.za and @uct.ac.za), so the domain decides the role.
function accountFor(email) {
  const domain = String(email).split('@')[1] || '';
  for (const u of UNIVERSITIES.filter((x) => x.live)) {
    if (domain === u.emailDomain) return { uni: u, role: 'student' };
    if (u.staffDomain && domain === u.staffDomain) return { uni: u, role: 'staff' };
  }
  return null;
}
// The university an email belongs to (student or staff), or null. Only live universities can sign in.
const uniForEmail = (email) => accountFor(email)?.uni || null;

module.exports = { UNIVERSITIES, CURRENT, uniForEmail, accountFor };
