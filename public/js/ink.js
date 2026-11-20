// Deterministic ink variation for each struck letter.
// Shared by the browser renderer and the server-side PDF export, so both match.

/* ---------- deterministic randomness so ink looks the same every render ---------- */
function mix(...nums) {
  let h = 2166136261;
  for (const n of nums) {
    h ^= n;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const slugCache = new Map();
/** Each letter's typebar is slightly misaligned — consistently, like a real machine. */
function slug(ch) {
  let s = slugCache.get(ch);
  if (!s) {
    const r = rng(mix(ch.codePointAt(0), 7919));
    s = { dx: (r() - 0.5) * 0.9, dy: (r() - 0.5) * 1.8, rot: (r() - 0.5) * 1.6, weight: 0.88 + r() * 0.14 };
    slugCache.set(ch, s);
  }
  return s;
}

export function glyphStyle(row, col, i, ch) {
  const r = rng(mix(row, col, i, ch.codePointAt(0)));
  const s = slug(ch);
  const dx = s.dx + (r() - 0.5) * 0.7;
  const dy = s.dy + (r() - 0.5) * 0.7;
  const rot = s.rot + (r() - 0.5) * 1.2;
  let op = s.weight * (0.8 + r() * 0.2);
  if (r() < 0.04) op *= 0.62; // a light strike
  let mask = '';
  if (r() < 0.3) {
    // uneven pressure: one side of the letter inks lighter
    const ang = Math.floor(r() * 360);
    const lo = (0.35 + r() * 0.35).toFixed(2);
    mask = `linear-gradient(${ang}deg, #000 ${30 + Math.floor(r() * 30)}%, rgba(0,0,0,${lo}))`;
  }
  return { dx, dy, rot, op, mask };
}

