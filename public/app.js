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
