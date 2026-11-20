// Synthesised typewriter sounds (Web Audio). No audio files needed.
let ctx = null;
let master = null;
let noise = null;

const rand = (a, b) => a + Math.random() * (b - a);

function ensure() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master = ctx.createGain();
  master.gain.value = state.volume;
  master.connect(comp).connect(ctx.destination);

  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return true;
}

const state = { enabled: true, volume: 0.6 };

function env(gainNode, t, peak, decay, attack = 0.0015) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** Filtered noise burst. */
function burst(t, { type = 'bandpass', freq = 2500, q = 1, peak = 0.6, decay = 0.04, attack } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, peak, decay, attack);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + decay + 0.05);
  return { src, f, g };
}

/** Low pitched body thump. */
function thump(t, { from = 150, to = 55, peak = 0.5, decay = 0.08 } = {}) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + decay);
  const g = ctx.createGain();
  env(g, t, peak, decay, 0.002);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + decay + 0.05);
}

function click(t, peak = 0.35, freq = 3800) {
  burst(t, { type: 'highpass', freq, q: 0.7, peak, decay: 0.012, attack: 0.0008 });
}

function play(fn) {
  if (!state.enabled || !ensure()) return;
  fn(ctx.currentTime + 0.002);
}

export const sound = {
  configure({ enabled, volume } = {}) {
    if (enabled !== undefined) state.enabled = enabled;
    if (volume !== undefined) state.volume = volume;
    if (master) master.gain.value = state.volume;
  },
  unlock() { if (state.enabled) ensure(); },

  key(heavy = false) {
    play((t) => {
      const p = heavy ? 1.15 : 1;
      // typebar slap on the platen
      burst(t, { freq: rand(2100, 3300), q: rand(0.9, 1.6), peak: rand(0.55, 0.8) * p, decay: rand(0.03, 0.05) });
      click(t, rand(0.25, 0.4) * p, rand(3500, 5200));
      thump(t, { from: rand(150, 190), to: 60, peak: rand(0.35, 0.5) * p, decay: 0.07 });
      // carriage escapement tick
      click(t + rand(0.022, 0.034), rand(0.1, 0.18), rand(4500, 6500));
    });
  },
  space() {
    play((t) => {
      thump(t, { from: 110, to: 45, peak: 0.45, decay: 0.09 });
      burst(t, { type: 'lowpass', freq: 900, q: 0.7, peak: 0.35, decay: 0.05 });
      click(t + 0.018, 0.14, 5200);
    });
  },
  back() {
    play((t) => {
      click(t, 0.25, 3000);
      thump(t, { from: 120, to: 60, peak: 0.2, decay: 0.05 });
    });
  },
  roll() {
    play((t) => {
      click(t, 0.3, 2600);
      click(t + 0.03, 0.16, 3600);
    });
  },
  ret() {
    play((t) => {
      // line-feed ratchet
      for (let i = 0; i < 3; i++) click(t + i * 0.028, 0.32 - i * 0.05, 2400 + i * 300);
      // carriage sliding back
      const s = burst(t + 0.07, { freq: 1800, q: 0.8, peak: 0.16, decay: 0.32, attack: 0.04 });
      s.f.frequency.setValueAtTime(2200, t + 0.07);
      s.f.frequency.exponentialRampToValueAtTime(500, t + 0.4);
      // carriage stop
      thump(t + 0.38, { from: 120, to: 40, peak: 0.6, decay: 0.12 });
      burst(t + 0.38, { type: 'lowpass', freq: 1400, peak: 0.45, decay: 0.07 });
      click(t + 0.385, 0.22, 3200);
    });
  },
  bell() {
    play((t) => {
      [[2637, 0.28], [5310, 0.1], [7920, 0.04], [1318, 0.05]].forEach(([f, a]) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * rand(0.998, 1.002);
        const g = ctx.createGain();
        env(g, t, a, 1.6, 0.002);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + 1.7);
      });
      click(t, 0.2, 6000);
    });
  },
  lock() {
    play((t) => {
      thump(t, { from: 90, to: 40, peak: 0.55, decay: 0.1 });
      burst(t, { type: 'lowpass', freq: 600, peak: 0.4, decay: 0.06 });
    });
  },
  feed() {
    play((t) => {
      const s = burst(t, { type: 'bandpass', freq: 1200, q: 0.5, peak: 0.22, decay: 0.7, attack: 0.08 });
      s.f.frequency.setValueAtTime(800, t);
      s.f.frequency.linearRampToValueAtTime(2600, t + 0.6);
      for (let i = 0; i < 8; i++) click(t + 0.05 + i * 0.07, 0.18, 2500);
    });
  },
};
