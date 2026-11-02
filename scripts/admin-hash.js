// Turns the admin password into the hash for ADMIN_PASSWORD_HASH. Run `npm run admin-hash`, type the password (nothing
// shows while you type), and copy the printed line into .env or the host's environment settings. The password itself
// is never saved anywhere.
const { hashPassword } = require('../src/admin');

function ask(prompt) {
  return new Promise((resolve) => {
    const input = process.stdin;
    // piped in (e.g. from a password manager): read it all, no prompt
    if (!input.isTTY) {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (c) => { data += c; });
      input.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let text = '';
    const onKey = (key) => {
      if (key === '\u0003') process.exit(1); // Ctrl+C
      if (key === '\r' || key === '\n') {
        input.setRawMode(false);
        input.pause();
        input.off('data', onKey);
        process.stdout.write('\n');
        return resolve(text);
      }
      if (key === '\u007f' || key === '\b') text = text.slice(0, -1);
      else text += key;
    };
    input.on('data', onKey);
  });
}

(async () => {
  const first = await ask('Admin password: ');
  if (first.length < 10) {
    console.error('Use at least 10 characters.');
    process.exit(1);
  }
  if (process.stdin.isTTY && first !== (await ask('Same again: '))) {
    console.error("The two didn't match. Nothing was made.");
    process.exit(1);
  }
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(first)}`);
})();
