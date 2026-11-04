// Tagged template that HTML-escapes every interpolated value unless it is already html``.
class Html {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
const render = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(render).join('') : v instanceof Html ? v.s : esc(v));

function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Html(out);
}

// markup our own code made (like a QR code's SVG) and that is safe as it is; never use it on anything a user typed
const raw = (s) => new Html(String(s));

module.exports = { html, esc, raw };
