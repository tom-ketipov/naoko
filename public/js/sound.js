// Synthesised typewriter sounds (Web Audio). No audio files needed.
//
// Tuned for a soft, close-up "ASMR" feel rather than a loud office machine:
// muted wooden thocks instead of metallic clacks, rounded attacks, high end
// gently rolled off, a little room ambience, and slight stereo movement so
// the machine feels like it sits right in front of you.
let ctx = null;
let master = null; // per-user volume
let bus = null; // everything plays into this
let noise = null;

const rand = (a, b) => a + Math.random() * (b - a);
const state = { enabled: true, volume: 0.6 };
const OUTPUT_TRIM = 0.7; // overall level: quieter than the volume slider alone

/** A short, dark, diffuse impulse response: a small quiet room. */
function roomImpulse(c) {
  const len = Math.floor(c.sampleRate * 0.45);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * 0.18; // darken the tail
      d[i] = lp * Math.pow(1 - t, 3.2);
    }
  }
  return ir;
}

function ensure() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();

  // bus -> soft low-pass -> (dry + small room) -> gentle compressor -> volume -> out
  bus = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5200;
  tone.Q.value = 0.5;
  const dry = ctx.createGain();
  dry.gain.value = 0.9;
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.16;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -22;
  comp.knee.value = 18;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  master = ctx.createGain();
  master.gain.value = state.volume * OUTPUT_TRIM;

  bus.connect(tone);
  tone.connect(dry).connect(comp);
  tone.connect(room).connect(wet).connect(comp);
  comp.connect(master).connect(ctx.destination);

  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return true;
}

/** Route a node into the bus with a stereo position (-1 left … 1 right). */
function out(node, pan = 0) {
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(p).connect(bus);
    return p;
  }
  node.connect(bus);
  return null;
}

function env(gainNode, t, peak, decay, attack = 0.003) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** Filtered noise burst. */
function burst(t, { type = 'bandpass', freq = 1200, q = 0.9, peak = 0.2, decay = 0.04, attack, pan = 0 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, peak, decay, attack);
  out(src.connect(f).connect(g), pan);
  src.start(t, Math.random() * 0.5);
  src.stop(t + decay + 0.08);
  return { src, f, g };
}

/** Soft low body resonance: the "thock". */
function thump(t, { from = 140, to = 70, peak = 0.25, decay = 0.09, attack = 0.004, pan = 0 } = {}) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + decay);
  const g = ctx.createGain();
  env(g, t, peak, decay, attack);
  out(o.connect(g), pan);
  o.start(t);
  o.stop(t + decay + 0.06);
}

/** A tiny, soft tick: crisp detail without sharpness. */
function tick(t, peak = 0.05, freq = 3200, pan = 0) {
  burst(t, { type: 'bandpass', freq, q: 1.4, peak, decay: 0.012, attack: 0.0015, pan });
}

function play(fn) {
  if (!state.enabled || !ensure()) return;
  fn(ctx.currentTime + 0.003);
}

export const sound = {
  configure({ enabled, volume } = {}) {
    if (enabled !== undefined) state.enabled = enabled;
    if (volume !== undefined) state.volume = volume;
    if (master) master.gain.value = state.volume * OUTPUT_TRIM;
  },
  unlock() { if (state.enabled) ensure(); },

  /** A key: muted wooden thock, a whisper of contact, a faint escapement tick. */
  key(heavy = false) {
    play((t) => {
      const p = heavy ? 1.12 : 1;
      const pan = rand(-0.12, 0.12);
      thump(t, { from: rand(150, 175), to: rand(62, 72), peak: rand(0.24, 0.3) * p, decay: rand(0.08, 0.1), pan });
      burst(t, { freq: rand(850, 1250), q: rand(0.7, 1.0), peak: rand(0.12, 0.17) * p, decay: rand(0.03, 0.045), attack: 0.0025, pan });
      tick(t + 0.001, rand(0.03, 0.05) * p, rand(2600, 3400), pan);
      tick(t + rand(0.026, 0.038), rand(0.012, 0.022), rand(3800, 4600), pan * 0.5);
    });
  },
  /** Space bar: a broad, soft pad. */
  space() {
    play((t) => {
      thump(t, { from: 115, to: 55, peak: 0.24, decay: 0.11, attack: 0.005 });
      burst(t, { type: 'lowpass', freq: 650, q: 0.6, peak: 0.1, decay: 0.06, attack: 0.004 });
      tick(t + 0.02, 0.012, 3600);
    });
  },
  back() {
    play((t) => {
      tick(t, 0.035, 2400, -0.1);
      thump(t, { from: 120, to: 70, peak: 0.1, decay: 0.05 });
    });
  },
  /** Platen knob: a soft little ratchet. */
  roll() {
    play((t) => {
      tick(t, 0.05, 2200, 0.2);
      tick(t + 0.035, 0.03, 2600, 0.2);
    });
  },
  /** Carriage return: soft ratchet, a slow swoosh drifting right to left, a cushioned landing. */
  ret() {
    play((t) => {
      for (let i = 0; i < 3; i++) tick(t + i * 0.032, 0.055 - i * 0.01, 2100 + i * 200, 0.35);
      const s = burst(t + 0.06, { freq: 1300, q: 0.6, peak: 0.065, decay: 0.38, attack: 0.07, pan: 0.4 });
      s.f.frequency.setValueAtTime(1500, t + 0.06);
      s.f.frequency.exponentialRampToValueAtTime(420, t + 0.46);
      thump(t + 0.42, { from: 105, to: 48, peak: 0.26, decay: 0.14, attack: 0.006, pan: -0.25 });
      burst(t + 0.42, { type: 'lowpass', freq: 700, peak: 0.12, decay: 0.08, attack: 0.004, pan: -0.25 });
    });
  },
  /** Margin bell: small, soft and far, like a bell under a cloth. */
  bell() {
    play((t) => {
      [[2093, 0.07], [4219, 0.022], [6280, 0.008], [1046, 0.02]].forEach(([f, a]) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * rand(0.998, 1.002);
        const g = ctx.createGain();
        env(g, t, a, 1.25, 0.004);
        out(o.connect(g), 0.45);
        o.start(t);
        o.stop(t + 1.35);
      });
    });
  },
  lock() {
    play((t) => {
      thump(t, { from: 90, to: 45, peak: 0.2, decay: 0.1, attack: 0.005 });
      burst(t, { type: 'lowpass', freq: 500, peak: 0.08, decay: 0.05 });
    });
  },
  /** New sheet: paper sliding in, a soft run of clicks. */
  feed() {
    play((t) => {
      const s = burst(t, { type: 'bandpass', freq: 1100, q: 0.45, peak: 0.07, decay: 0.75, attack: 0.12 });
      s.f.frequency.setValueAtTime(700, t);
      s.f.frequency.linearRampToValueAtTime(1900, t + 0.65);
      for (let i = 0; i < 7; i++) tick(t + 0.06 + i * 0.075, 0.03, 2100 + rand(-150, 150), 0.15);
    });
  },
};
