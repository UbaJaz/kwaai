// public/app.js is plain browser script; run it against a tiny DOM stub to check the class tabs and busy buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const el = (props = {}) => {
  const attrs = { ...(props.attrs || {}) };
  return { dataset: {}, hidden: false, classList: { add() {}, contains: (c) => (props.classes || []).includes(c) }, closest: () => null, scrollIntoView() {}, addEventListener() {}, ...props,
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, toggleAttribute: (k, on) => { if (on) attrs[k] = ''; else delete attrs[k]; }, getAttribute: (k) => attrs[k], attrs };
};

function run({ hash = '', tabNames = ['students', 'attendance', 'class', 'setup'], ids = {} } = {}) {
  const tabs = tabNames.map((n) => el({ dataset: { tab: n }, classes: ['class-tab'] }));
  const links = tabNames.map((n) => el({ dataset: { tab: n } }));
  const nav = el({ querySelectorAll: () => links });
  const listeners = {};
  const doc = {
    querySelectorAll: (sel) => (sel === '[data-class-tabs]' ? [nav] : sel === '.class-tab' ? tabs : []),
    getElementById: (id) => ids[id] || null, querySelector: () => null, body: el(), documentElement: el(),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const ctx = { document: doc, location: { hash }, addEventListener() {}, confirm: () => true, setTimeout: (f) => f(), console, navigator: {}, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  return { tabs, links, listeners };
}

test('class tabs: Students show first, and a link into another tab opens that tab', () => {
  const first = run();
  assert.deepEqual(first.tabs.map((t) => t.hidden), [false, true, true, true]);
  assert.equal(first.links[0].getAttribute('aria-current'), 'page');
  // #roster sits inside the setup tab
  const setup = el({ dataset: { tab: 'setup' }, classes: ['class-tab'] });
  const roster = el({ closest: () => setup });
  const deep = run({ hash: '#roster', ids: { roster } });
  assert.deepEqual(deep.tabs.map((t) => t.hidden), [true, true, true, false]);
  assert.equal(deep.links[3].getAttribute('aria-current'), 'page');
});

test('busy button: a submitted form locks its button, and a cancelled one does not', () => {
  const { listeners } = run();
  const btn = el();
  const submit = (defaultPrevented) => listeners.submit({ defaultPrevented, target: { querySelector: () => btn } });
  submit(true);
  assert.equal(btn.getAttribute('aria-busy'), undefined, 'a cancelled confirm leaves it alone');
  submit(false);
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.equal(btn.disabled, true);
});
