// Progressive enhancement only: every form works without this file.
document.querySelectorAll('input[type=range]').forEach((input) => {
  const out = document.querySelector(`output[for="${input.id}"]`);
  input.addEventListener('input', () => { out.textContent = input.value; });
});

document.querySelectorAll('.tag-picker').forEach((picker) => {
  const max = Number(picker.dataset.max);
  const boxes = [...picker.querySelectorAll('input[type=checkbox]')];
  const sync = () => {
    const full = boxes.filter((b) => b.checked).length >= max;
    boxes.forEach((b) => { b.disabled = full && !b.checked; });
  };
  picker.addEventListener('change', sync);
  sync();
});

document.querySelectorAll('textarea[data-counter]').forEach((ta) => {
  const out = ta.parentElement.querySelector('.counter');
  const sync = () => { out.textContent = `${ta.value.length} / ${ta.maxLength}`; };
  ta.addEventListener('input', sync);
  sync();
});

document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => { if (!confirm(form.dataset.confirm)) e.preventDefault(); });
});

document.querySelectorAll('select[data-autosubmit]').forEach((sel) => {
  sel.addEventListener('change', () => sel.form.submit());
});

// Course suggestions as you type ("csc1" lists CSC1010H, CSC1015F, ...), as an ARIA combobox.
// data-suggest="go" opens the course page; "fill" puts the code in the box and submits the form (the planner's Add).
// Without this script the box is an ordinary search form.
document.querySelectorAll('input[data-suggest]').forEach((input, n) => {
  const form = input.form;
  const list = document.createElement('ul');
  const status = document.createElement('p');
  list.id = `suggest-${n}`;
  list.className = 'suggest';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Matching courses');
  list.hidden = true;
  status.className = 'sr-only';
  status.setAttribute('aria-live', 'polite');
  form.classList.add('has-suggest');
  form.append(list, status);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  let items = [];
  let active = -1;
  let timer;
  let request;
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${i}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = (c) => {
    if (input.dataset.suggest === 'go') return void (window.location.href = `/courses/${c.code}`);
    if (input.dataset.suggest === 'pick') { input.value = c.code; close(); return; } // fill the box, the person submits
    input.value = c.code;
    close();
    form.requestSubmit ? form.requestSubmit() : form.submit();
  };
  const render = () => {
    list.replaceChildren(...items.map((c, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = c.code;
      const title = document.createElement('span');
      title.className = 'suggest-title';
      title.textContent = c.title;
      const meta = document.createElement('span');
      meta.className = 'suggest-meta';
      meta.textContent = [c.dept_name, c.reviews ? `${c.reviews} review${c.reviews === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
      li.append(code, title, meta);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(c); });
      return li;
    }));
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(items.length > 0));
    status.textContent = items.length ? `${items.length} course${items.length === 1 ? '' : 's'} found. Use the arrow keys to pick one.` : '';
    highlight(-1);
  };
  const lookup = () => {
    const text = input.value.trim();
    if (text.length < 2) { items = []; return render(); }
    request?.abort();
    request = new AbortController();
    fetch(`/api/courses?q=${encodeURIComponent(text)}`, { signal: request.signal, headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => { items = rows; render(); })
      .catch(() => {}); // aborted by a newer keystroke, or offline: the plain form still works
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 120); });
  input.addEventListener('focus', () => { if (items.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      if (list.hidden) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
      highlight((active + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      highlight(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter' && active >= 0 && !list.hidden) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();
      close();
    }
  });
});

// Marks and DP (/marks and /today). Marks are saved in this browser only (localStorage) and never sent anywhere.
// public/marks-math.js does the sums; it loads after this file, so this waits for the page.
document.addEventListener('DOMContentLoaded', () => {
  const M = window.KwaaiMarks;
  if (!M) return;
  const KEY = 'kwaai.marks.v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (all) => { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: works, just isn't kept */ } };
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.max(0, Math.min(100, Number(v))));
  // saved { rows: [{ n, w, e, m }], dp, sub } -> what compute() needs
  const fromSaved = (s) => {
    const rows = (s.rows || []).filter((r) => Number(r.w) > 0);
    return { items: rows.map((r) => ({ name: r.n, weight: Number(r.w), exam: !!r.e })), marks: rows.map((r) => (num(r.m) == null ? '' : num(r.m))), opts: { dpMin: num(s.dp), examSub: num(s.sub) } };
  };
  const show = (list, lines) => list.replaceChildren(...lines.map((l) => {
    const li = document.createElement('li');
    li.textContent = l.text;
    if (l.tone) li.className = l.tone === 'ok' ? 'ok-text' : 'bad';
    return li;
  }));

  document.querySelectorAll('form[data-marks]').forEach((form) => {
    const id = form.dataset.marks;
    const field = (name) => form.elements.namedItem(name);
    const saved = load()[id];
    if (saved) {
      (saved.rows || []).forEach((r, i) => {
        if (!field(`n${i}`)) return;
        field(`n${i}`).value = r.n ?? '';
        field(`w${i}`).value = r.w ?? '';
        field(`e${i}`).checked = !!r.e;
        field(`m${i}`).value = r.m ?? '';
      });
      field('dp').value = saved.dp ?? '';
      field('sub').value = saved.sub ?? '';
    }
    const read = () => {
      const rows = [];
      for (let i = 0; field(`n${i}`); i++) rows.push({ n: field(`n${i}`).value, w: field(`w${i}`).value, e: field(`e${i}`).checked, m: field(`m${i}`).value });
      return { rows, dp: field('dp').value, sub: field('sub').value };
    };
    const update = (keep) => {
      const state = read();
      if (keep) { const all = load(); all[id] = state; save(all); }
      const { items, marks, opts } = fromSaved(state);
      show(form.querySelector('.marks-result'), M.describe(items.length ? M.compute(items, marks, opts) : null));
    };
    form.addEventListener('input', () => update(true));
    form.addEventListener('change', () => update(true));
    form.addEventListener('submit', (e) => { e.preventDefault(); update(true); });
    update(false);
  });

  // Today: an alert for each course below DP or out of reach of a pass, from the marks saved on this device
  const box = document.querySelector('[data-dp-alerts]');
  if (box) {
    const all = load();
    const alerts = [];
    let tracked = 0;
    for (const c of JSON.parse(box.dataset.courses || '[]')) {
      const saved = all[c.code];
      if (!saved) continue;
      const { items, marks, opts } = fromSaved(saved);
      const r = items.length ? M.compute(items, marks, opts) : null;
      if (!r || r.classSoFar == null) continue;
      tracked++;
      const pass = r.needed.find((n) => n.target === 50);
      if (r.dp === 'below') alerts.push({ tone: 'bad', text: `${c.code}: class mark ${r.classSoFar}%, below the ${r.dpMin}% DP minimum.` });
      else if (pass && !pass.possible) alerts.push({ tone: 'bad', text: `${c.code}: a pass needs ${pass.need}% in the exam. Talk to your lecturer about options.` });
      else if (pass) alerts.push({ tone: pass.need > 70 ? 'bad' : 'ok', text: `${c.code}: you need ${pass.need}% in the exam to pass.` });
    }
    if (tracked) {
      const list = document.createElement('ul');
      list.className = 'plain';
      show(list, alerts);
      box.querySelector('.dp-alerts-text').replaceWith(list);
    }
  }
});

// The phone tab bar's More sheet: a tap outside it or Escape closes it (it opens and closes without this script too)
document.querySelectorAll('[data-tab-more]').forEach((more) => {
  document.addEventListener('click', (e) => { if (more.open && !more.contains(e.target)) more.open = false; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary').focus(); }
  });
});

/// The tutor's attendance screen: every 4 seconds, a fresh QR code (it changes every 20 seconds), the count and the
// newest names. Without this script the page still works; it just needs a refresh for a new code.
document.querySelectorAll('[data-attend-live]').forEach((screen) => {
  const qr = screen.querySelector('[data-attend-qr]');
  const count = screen.querySelector('[data-attend-count]');
  const recent = screen.querySelector('[data-attend-recent]');
  const tick = () => fetch(screen.dataset.attendLive, { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      if (!d.open) { window.location.reload(); return; }
      qr.innerHTML = d.qr; // our own server's SVG
      count.textContent = String(d.count);
      recent.replaceChildren(...d.recent.map((name) => { const li = document.createElement('li'); li.textContent = name; return li; }));
    })
    .catch(() => { /* offline for a moment: the next tick tries again */ });
  setInterval(tick, 4000);
});

// Installable app: the service worker keeps Today, the week, the year and Marks working offline (public/sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* the site works without it */ }));
}
// "Add Kwaai to your home screen": shown from a student's second day of using Kwaai, never inside the installed app,
// and "Not now" hides it for 30 days. Android browsers give us an install prompt; on iPhones it says how instead.
(() => {
  const box = document.querySelector('[data-install]');
  if (!box || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
  const KEY = 'kwaai.install';
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* private mode */ }
  const today = new Date().toISOString().slice(0, 10);
  if (s.lastDay !== today) s = { ...s, days: (s.days || 0) + 1, lastDay: today };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } };
  save();
  if (s.days < 2 || (s.dismissed && Date.now() - s.dismissed < 30 * 86_400_000)) return;
  const add = box.querySelector('[data-install-add]');
  const close = () => { s.dismissed = Date.now(); save(); box.hidden = true; };
  box.querySelector('[data-install-later]').addEventListener('click', close);
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    box.querySelector('[data-install-text]').textContent = 'On iPhone: tap the Share button at the bottom of Safari, then "Add to Home Screen".';
    add.hidden = true;
    box.hidden = false;
    return;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    box.hidden = false;
    add.onclick = () => { e.prompt(); e.userChoice.finally(close); };
  });
})();

// signing out clears the pages saved for offline, so the next person on a shared phone doesn't see them
document.querySelectorAll('form[action="/logout"]').forEach((form) => form.addEventListener('submit', () => {
  if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
}));

// Wrapped: the phone's share sheet, where there is one
document.querySelectorAll('[data-share]').forEach((btn) => {
  if (!navigator.share) return;
  btn.hidden = false;
  btn.addEventListener('click', () => navigator.share({ title: 'My semester on Kwaai', text: btn.dataset.shareText, url: btn.dataset.shareUrl }).catch(() => { /* closed the share sheet */ }));
});

// The streak celebration: once a day per device, the first time a page shows that today counts. The number ticks up,
// the flame flares, and a milestone (7 days, 30 days...) gets confetti and its own line. Nothing moves for people who
// prefer less motion; the milestone line still shows.
(() => {
  const KEY = 'kwaai.celebrated';
  document.querySelectorAll('[data-replay-celebration]').forEach((btn) => btn.addEventListener('click', () => {
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
    btn.textContent = 'Done: open Study to see it';
  }));
  const el = document.querySelector('[data-celebrate]');
  if (!el) return;
  try {
    if (localStorage.getItem(KEY) === el.dataset.celebrate) return;
    localStorage.setItem(KEY, el.dataset.celebrate);
  } catch { /* private mode: celebrate every time, no harm */ }
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const n = el.querySelector('.streak-n');
  const to = Number(el.dataset.streak);
  if (!calm && to > 1) {
    n.textContent = String(to - 1);
    setTimeout(() => { n.textContent = String(to); el.classList.add('celebrate'); }, 400);
  } else el.classList.add('celebrate');
  if (!el.dataset.milestone) return;
  const note = document.createElement('p');
  note.className = 'milestone-note';
  note.setAttribute('role', 'status');
  note.textContent = el.dataset.milestone;
  (el.closest('dl, a') || el).insertAdjacentElement('afterend', note);
  if (calm) return;
  const box = el.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  const colours = ['#c8f169', '#151d2b', '#2f9a55', '#f2b134', getComputedStyle(document.body).getPropertyValue('--uni').trim() || '#0b3c5d'];
  for (let i = 0; i < 40; i++) {
    const bit = document.createElement('i');
    bit.style.left = `${box.left + box.width / 2}px`;
    bit.style.top = `${box.top + box.height / 2}px`;
    bit.style.setProperty('--c', colours[i % colours.length]);
    bit.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 520)}px`);
    bit.style.setProperty('--dy', `${-Math.round(120 + Math.random() * 260)}px`);
    bit.style.setProperty('--r', `${Math.round((Math.random() - 0.5) * 1080)}deg`);
    bit.style.animationDelay = `${Math.round(Math.random() * 120) + 350}ms`;
    layer.append(bit);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 2600);
})();

// Numbers count up from zero the first time they come into view: study minutes (data-count, written like the server
// writes them, "1 h 5 min") and Wrapped's hours (data-unit="hours", "62.9 h"). Each one ends on exactly the server's
// text. The heatmap's days fade in week by week. Nothing moves for people who prefer less motion.
(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const minutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  const countUp = (el) => {
    const end = Number(el.dataset.count);
    const final = el.textContent;
    const hours = el.dataset.unit === 'hours';
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 700);
      const v = end * (1 - (1 - k) ** 3); // eases out
      el.textContent = k < 1 ? (hours ? `${Math.round(v / 6) / 10} h` : minutes(Math.round(v))) : final;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const seen = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    seen.unobserve(e.target);
    if (e.target.dataset.count) countUp(e.target);
    else e.target.classList.add('reveal');
  }), { threshold: 0.2 });
  document.querySelectorAll('[data-count]').forEach((el) => { if (Number(el.dataset.count) > 0) seen.observe(el); });
  document.querySelectorAll('[data-reveal]').forEach((grid) => {
    [...grid.children].forEach((cell, i) => { cell.style.transitionDelay = `${Math.floor(i / 7) * 12}ms`; }); // one week a beat
    grid.classList.add('pre-reveal');
    seen.observe(grid);
  });
})();

// the study heatmap opens scrolled to this week, its right-hand end
document.querySelectorAll('[data-heatmap]').forEach((el) => { el.scrollLeft = el.scrollWidth; });

// Study timer (/study). The countdown runs here. The server only counts time from the heartbeats this page sends
// about once a minute, so the page has to stay open (another tab is fine). Signed out, the timer runs on this device
// only and nothing is sent.
//
// Rounds: a preset (25, 50, 90 min) is one focus block and then a break. Custom sets the focus and break lengths,
// how many rounds, a longer break every 4th round, and whether the next round starts by itself. Signed in, each focus
// round is its own logged session, so the plan for the rounds waits in sessionStorage across the reload after each.
(() => {
  const CYCLE_KEY = 'kwaai.cycle';
  const SETTINGS_KEY = 'kwaai.timer.v1';
  const LONG_EVERY = 4;
  const baseTitle = document.title;
  const fmt = (sec) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const breakFor = (min) => ({ 25: 5, 50: 10, 90: 15 }[min] ?? Math.max(5, Math.round(min / 6)));
  const minutesText = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  const store = {
    get: (key, where = sessionStorage) => { try { return JSON.parse(where.getItem(key)); } catch { return null; } },
    set: (key, value, where = sessionStorage) => { try { where.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
    drop: (key, where = sessionStorage) => { try { where.removeItem(key); } catch { /* private mode */ } },
  };
  // Sounds (public/sounds.js) and vibration, as picked under "Timer sounds" and saved on this device.
  // kind is 'focus' (a focus block ended) or 'break' (a break ended).
  const SOUND_KEY = 'kwaai.sound.v1';
  const sound = () => ({ focus: 'bell', break: 'birds', volume: 70, vibrate: true, ...(store.get(SOUND_KEY, localStorage) || {}) });
  const chime = (kind = 'focus') => {
    const s = sound();
    if (s.vibrate) navigator.vibrate?.(kind === 'focus' ? [200, 100, 200] : [120]);
    window.KwaaiSounds?.play(s[kind], s.volume / 100);
  };
  // browsers keep sound blocked until the person taps the page, so the first tap unlocks it
  ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, () => window.KwaaiSounds?.unlock(), { once: true, capture: true }));
  const soundPanel = document.querySelector('[data-sound-settings]');
  if (soundPanel) {
    const field = (name) => soundPanel.querySelector(`[name=${name}]`);
    const s = sound();
    field('focus').value = s.focus;
    field('break').value = s.break;
    field('volume').value = s.volume;
    field('vibrate').checked = s.vibrate;
    soundPanel.addEventListener('change', () => store.set(SOUND_KEY, { focus: field('focus').value, break: field('break').value, volume: Number(field('volume').value), vibrate: field('vibrate').checked }, localStorage));
    soundPanel.querySelectorAll('[data-sound-preview]').forEach((button) => button.addEventListener('click', () => {
      window.KwaaiSounds?.unlock();
      window.KwaaiSounds?.play(field(button.dataset.soundPreview).value, Number(field('volume').value) / 100);
    }));
  }
  // a running timer on a freshly loaded page can't ring until a tap: say so, until there is one
  const soundHint = document.querySelector('[data-sound-hint]');
  if (soundHint) {
    setTimeout(() => {
      if (window.KwaaiSounds?.ready() || sound().focus === 'none') return;
      soundHint.hidden = false;
      document.addEventListener('pointerdown', () => { soundHint.hidden = true; }, { once: true });
    }, 1500);
  }
  // counts down to endAt (this device's clock) once a second, in the element and the tab title
  // when the clock sits in a progress ring ([data-ring] with data-total seconds), the ring fills as time passes,
  // pulses in the last minute, and shows a check mark at the end
  const countdown = (el, endAt, label, onDone) => {
    let done = false;
    const ring = el.closest('[data-ring]');
    const total = Number(ring?.dataset.total) || 0;
    const render = () => {
      const left = (endAt - Date.now()) / 1000;
      el.textContent = fmt(left);
      document.title = `${fmt(left)} ${label} · ${baseTitle}`;
      if (ring && total) {
        ring.style.setProperty('--p', Math.min(1, Math.max(0, 1 - left / total)).toFixed(4));
        ring.classList.toggle('last-minute', left > 0 && left <= 60);
      }
      if (left <= 0 && !done) { done = true; clearInterval(timer); document.title = baseTitle; ring?.classList.add('done'); onDone(); }
    };
    const timer = setInterval(render, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    render();
    return () => { done = true; clearInterval(timer); document.title = baseTitle; };
  };
  // the break after round n: a long one every 4th round of a custom plan
  const breakAfter = (plan, round) => (round % LONG_EVERY === 0 ? plan.long : plan.short);

  // The start form: remember the custom settings, and turn the choice into a plan for the rounds.
  const form = document.querySelector('form[action="/study/start"]');
  const planFrom = (f) => {
    const d = new FormData(f);
    const num = (key, lo, hi, fallback) => Math.min(hi, Math.max(lo, Math.round(Number(d.get(key))) || fallback));
    const course = String(d.get('course') || '');
    if (d.get('minutes') !== 'custom') {
      const focus = Number(d.get('minutes')) || 25;
      return { course, focus, short: breakFor(focus), long: breakFor(focus), rounds: 1, auto: false };
    }
    return { course, focus: num('focus', 5, 120, 45), short: num('break', 1, 30, 10), long: num('long', 1, 45, 20), rounds: num('rounds', 1, 8, 4), auto: d.get('auto') === '1' };
  };
  if (form) {
    const saved = store.get(SETTINGS_KEY, localStorage);
    if (saved) {
      for (const key of ['focus', 'break', 'rounds', 'long']) if (saved[key] != null && form.elements.namedItem(key)) form.elements.namedItem(key).value = saved[key];
      if (form.elements.namedItem('auto')) form.elements.namedItem('auto').checked = saved.auto !== false;
      if (saved.custom) form.querySelector('input[name=minutes][value=custom]')?.click();
    }
    form.addEventListener('submit', () => {
      const d = new FormData(form);
      store.set(SETTINGS_KEY, { focus: d.get('focus'), break: d.get('break'), rounds: d.get('rounds'), long: d.get('long'), auto: d.get('auto') === '1', custom: d.get('minutes') === 'custom' }, localStorage);
      if (!form.hasAttribute('data-study-local')) store.set(CYCLE_KEY, { ...planFrom(form), round: 1, phase: 'focus' });
    });
  }

  // Between rounds (signed in): the break counts down here, then the next round starts by itself or with a tap.
  const breakNote = document.querySelector('[data-break]');
  const cycle = store.get(CYCLE_KEY);
  if (breakNote && cycle && !document.querySelector('[data-study]')) {
    const csrf = form?.elements.namedItem('_csrf')?.value;
    const more = cycle.round < cycle.rounds;
    const startRound = () => {
      const body = new URLSearchParams({ _csrf: csrf, course: cycle.course, minutes: 'custom', focus: String(cycle.focus) });
      fetch('/study/start', { method: 'POST', headers: { accept: 'application/json' }, body })
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then(() => { store.set(CYCLE_KEY, { ...cycle, round: cycle.round + 1, phase: 'focus' }); window.location.reload(); })
        .catch(() => { breakNote.querySelector('[data-break-text]').textContent = "Couldn't start the next round. Check your connection and tap again."; });
    };
    breakNote.hidden = false;
    breakNote.innerHTML = '<span data-break-text></span> <span class="break-actions"></span>';
    const text = breakNote.querySelector('[data-break-text]');
    const actions = breakNote.querySelector('.break-actions');
    const button = (label, onClick, quiet) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-small${quiet ? ' btn-quiet' : ''}`;
      b.textContent = label;
      b.addEventListener('click', onClick);
      actions.append(b);
    };
    if (cycle.phase === 'done') {
      text.textContent = `All ${cycle.rounds} rounds done: ${minutesText(cycle.rounds * cycle.focus)} of focus, each one logged.`;
      store.drop(CYCLE_KEY);
    } else if (cycle.phase === 'break') {
      const ready = () => {
        if (!more) { text.textContent = 'Break over. Ready for the next one?'; store.drop(CYCLE_KEY); return; }
        text.textContent = `Break over. Round ${cycle.round + 1} of ${cycle.rounds} is next.`;
        actions.replaceChildren();
        button(`Start round ${cycle.round + 1}`, startRound);
        button('End the rounds', () => { store.drop(CYCLE_KEY); breakNote.hidden = true; }, true);
      };
      if (cycle.breakEnd > Date.now()) {
        text.innerHTML = `${more ? `Break after round ${cycle.round} of ${cycle.rounds}` : 'Break'}: <strong></strong> left. Stand up, drink some water.`;
        if (more) {
          button(`Start round ${cycle.round + 1} now`, startRound);
          button('End the rounds', () => { store.drop(CYCLE_KEY); breakNote.hidden = true; }, true);
        }
        countdown(text.querySelector('strong'), cycle.breakEnd, 'break', () => {
          chime('break');
          if (more && cycle.auto) startRound();
          else ready();
        });
      } else ready();
    }
  }

  // A session the server is timing.
  const box = document.querySelector('[data-study]');
  if (box) {
    const st = JSON.parse(box.dataset.study);
    const skew = st.now - Date.now(); // the server's clock minus this device's
    const stopForm = box.querySelector('[data-study-stop]');
    const csrf = stopForm.elements.namedItem('_csrf').value;
    const post = (path) => fetch(path, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrf }) })
      .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : null))
      .catch(() => null); // offline: this minute won't count, the next heartbeat tries again
    const plan = store.get(CYCLE_KEY);
    if (plan?.phase === 'focus' && plan.rounds > 1) box.querySelector('h2').append(` · round ${plan.round} of ${plan.rounds}`);
    stopForm.addEventListener('submit', () => store.drop(CYCLE_KEY)); // stopping early ends the rounds
    let over = false;
    const beat = () => post('/study/beat').then((r) => { if (r && !r.running && !over) { over = true; window.location.reload(); } });
    const heartbeat = setInterval(beat, 60_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !over) beat(); });
    countdown(box.querySelector('[data-clock]'), st.startedAt + st.plannedMin * 60_000 - skew, 'studying', () => {
      over = true;
      clearInterval(heartbeat);
      chime();
      const c = plan?.phase === 'focus' ? plan : { course: st.course, focus: st.plannedMin, short: breakFor(st.plannedMin), long: breakFor(st.plannedMin), rounds: 1, auto: false, round: 1 };
      const last = c.rounds > 1 && c.round >= c.rounds;
      store.set(CYCLE_KEY, last ? { ...c, phase: 'done' } : { ...c, phase: 'break', breakEnd: Date.now() + breakAfter(c, c.round) * 60_000 });
      box.querySelector('[data-study-status]').textContent = 'Done. Logging your time...';
      post('/study/stop').then(() => setTimeout(() => window.location.reload(), 1200));
    });
  }

  // Signed out, or offline: the same timer and rounds, on this device only. Signed in but offline, the start can't
  // reach Kwaai, so the round runs here and isn't logged (the page says so).
  const local = form;
  if (local) {
    local.addEventListener('submit', (e) => {
      const offline = !local.hasAttribute('data-study-local');
      if (offline && navigator.onLine !== false) return; // online and signed in: the server times it
      e.preventDefault();
      if (offline) store.drop(CYCLE_KEY);
      const plan = planFrom(local);
      const name = plan.course || 'General study';
      const panel = local.closest('section');
      const heading = panel.querySelector('h2');
      const ring = document.createElement('div');
      ring.className = 'timer-ring';
      ring.dataset.ring = '';
      ring.innerHTML = document.querySelector('template[data-ring-svg]')?.innerHTML ?? '';
      const clock = document.createElement('p');
      clock.className = 'study-clock';
      clock.setAttribute('role', 'timer');
      ring.append(clock);
      const note = document.createElement('p');
      note.className = 'meta';
      note.textContent = offline ? "You're offline, so this runs on this device only and won't be logged." : 'On this device only. Sign in to keep your hours.';
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn btn-big btn-ink';
      stop.textContent = 'Stop';
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'btn btn-big';
      next.hidden = true;
      local.replaceWith(ring, note, next, stop);
      stop.focus();
      let cancel = () => {};
      const roundText = (round) => (plan.rounds > 1 ? ` · round ${round} of ${plan.rounds}` : '');
      const phase = (seconds) => {
        ring.classList.remove('done', 'last-minute');
        ring.dataset.total = String(seconds);
        ring.style.setProperty('--p', '0');
      };
      const focus = (round) => {
        next.hidden = true;
        heading.textContent = `Studying ${name}${roundText(round)}`;
        phase(plan.focus * 60);
        cancel = countdown(clock, Date.now() + plan.focus * 60_000, 'studying', () => {
          chime();
          if (plan.rounds > 1 && round >= plan.rounds) {
            heading.textContent = `Done: ${plan.rounds} rounds, ${minutesText(plan.rounds * plan.focus)} of ${name}`;
            note.textContent = 'Sign in next time and Kwaai keeps your hours.';
            stop.textContent = 'Start another';
            return;
          }
          rest(round);
        });
      };
      const rest = (round) => {
        const more = round < plan.rounds;
        heading.textContent = `Break${more ? ` after round ${round} of ${plan.rounds}` : ''}`;
        phase(breakAfter(plan, round) * 60);
        if (more) { next.hidden = false; next.textContent = `Start round ${round + 1} now`; next.onclick = () => { cancel(); focus(round + 1); }; }
        cancel = countdown(clock, Date.now() + breakAfter(plan, round) * 60_000, 'break', () => {
          chime('break');
          if (more && plan.auto) return focus(round + 1);
          heading.textContent = more ? `Break over. Round ${round + 1} is next.` : `Done: ${minutesText(plan.focus)} of ${name}`;
          if (!more) { note.textContent = 'Take a break, then start the next one. Sign in next time and Kwaai keeps your hours.'; stop.textContent = 'Start another'; }
        });
      };
      stop.addEventListener('click', () => { cancel(); window.location.reload(); });
      focus(1);
    });
  }
})();
