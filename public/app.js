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
