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

// Installable app: the service worker keeps Today, the week, the year and Marks working offline (public/sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* the site works without it */ }));
}
// signing out clears the pages saved for offline, so the next person on a shared phone doesn't see them
document.querySelectorAll('form[action="/logout"]').forEach((form) => form.addEventListener('submit', () => {
  if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
}));
