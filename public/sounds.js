// Timer sounds, made in the browser with the Web Audio API: no audio files to download and nothing to license.
// window.KwaaiSounds.play(name, volume) plays one; unlock() should run on a tap, because browsers keep sound
// blocked until the person has touched the page.
(() => {
  let ctx = null;
  const context = () => {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };

  // one note: an oscillator through a gain that rises fast and fades out
  const note = (c, out, { type = 'sine', freq, at = 0, length = 1, peak = 0.3, attack = 0.005, slideTo = null }) => {
    const t = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + length * 0.8);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + length + 0.05);
  };

  const SOUNDS = {
    // a struck bell: a low note with the out-of-tune overtones that make metal sound like metal, ringing out
    bell: (c, out) => {
      [[1, 0.35], [2.76, 0.12], [5.4, 0.06], [8.93, 0.03]].forEach(([ratio, peak]) => note(c, out, { freq: 523 * ratio, length: 2.6 / Math.sqrt(ratio), peak }));
      [[1, 0.25], [2.76, 0.08]].forEach(([ratio, peak]) => note(c, out, { freq: 659 * ratio, at: 0.45, length: 2.2 / Math.sqrt(ratio), peak }));
    },
    // birdsong: quick rising whistles, the last one with a little trill
    birds: (c, out) => {
      [[2600, 3900, 0], [2800, 4200, 0.18], [3000, 4400, 0.36]].forEach(([from, to, at]) => note(c, out, { freq: from, slideTo: to, at, length: 0.13, peak: 0.14, attack: 0.01 }));
      for (let i = 0; i < 4; i++) note(c, out, { freq: 3800 - i * 120, slideTo: 4300 - i * 120, at: 0.7 + i * 0.07, length: 0.06, peak: 0.1, attack: 0.005 });
    },
    // three rising notes, soft and round
    chime: (c, out) => {
      [[1047, 0], [1319, 0.16], [1568, 0.32]].forEach(([freq, at]) => note(c, out, { type: 'triangle', freq, at, length: 1.2, peak: 0.22 }));
    },
    // wooden mallet hits: a short note with a quick fade, plus a faint higher partial
    marimba: (c, out) => {
      [[784, 0], [1047, 0.2], [784, 0.4]].forEach(([freq, at]) => {
        note(c, out, { freq, at, length: 0.45, peak: 0.32, attack: 0.003 });
        note(c, out, { freq: freq * 4, at, length: 0.08, peak: 0.05, attack: 0.002 });
      });
    },
    // two short beeps, kept quiet
    beep: (c, out) => {
      [0, 0.25].forEach((at) => note(c, out, { type: 'square', freq: 880, at, length: 0.15, peak: 0.06, attack: 0.003 }));
    },
  };
  const NAMES = { bell: 'Bell', birds: 'Birdsong', chime: 'Chime', marimba: 'Marimba', beep: 'Soft beep', none: 'No sound' };

  window.KwaaiSounds = {
    NAMES,
    // true if sound can play now (false until the person has tapped the page, on most phones)
    ready: () => !!ctx && ctx.state === 'running',
    unlock: () => { context(); },
    play: (name, volume = 0.7) => {
      const make = SOUNDS[name];
      if (!make) return false;
      const c = context();
      if (!c) return false;
      const out = c.createGain();
      out.gain.value = Math.max(0, Math.min(1, volume));
      out.connect(c.destination);
      make(c, out);
      return true;
    },
  };
})();
