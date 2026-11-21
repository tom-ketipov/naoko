// The typewriter itself, drawn out of focus in the foreground below the rail:
// type-bar basket, ribbon spools and rows of round keys. It is dark metal, so
// it only shows where the lamp catches it. Colours come from the lamp CSS vars.

const W = 1000;
const H = 440;
const BASKET_Y = 30;

const f = (n) => Math.round(n * 10) / 10;

function typeBars() {
  let out = '';
  const n = 44;
  for (let i = 0; i < n; i++) {
    const a = ((12 + (i * 156) / (n - 1)) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out += `<line x1="${f(c * 74)}" y1="${f(BASKET_Y + s * 74)}" x2="${f(c * 206)}" y2="${f(BASKET_Y + s * 206)}"/>`;
  }
  return out;
}

function keys() {
  const rows = [
    { y: 286, n: 10, r: 13, dx: 46 },
    { y: 330, n: 11, r: 14, dx: 49 },
    { y: 376, n: 11, r: 15.5, dx: 52 },
    { y: 424, n: 10, r: 17, dx: 56 },
  ];
  let caps = '';
  let glints = '';
  rows.forEach((row, ri) => {
    const off = ri % 2 ? row.dx / 2 : 0;
    for (let i = 0; i < row.n; i++) {
      const x = (i - (row.n - 1) / 2) * row.dx + off - row.dx / 4;
      caps += `<circle cx="${f(x)}" cy="${row.y}" r="${row.r}"/>`;
      // a rim highlight on the side of the key facing the lamp, brighter near the middle
      const near = Math.max(0, 1 - Math.abs(x) / 300) * (1 - ri * 0.18);
      if (near > 0.08) {
        const ang = Math.atan2(-row.y, -x);
        const gx = x + Math.cos(ang) * row.r * 0.78;
        const gy = row.y + Math.sin(ang) * row.r * 0.78;
        glints += `<circle cx="${f(gx)}" cy="${f(gy)}" r="${f(2 + near * 2.4)}" opacity="${f(near * 0.9 * 100) / 100}"/>`;
      }
    }
  });
  return { caps, glints };
}

export function machineSvg() {
  const k = keys();
  return `<svg class="machine-svg" viewBox="${-W / 2} 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
  <defs>
    <radialGradient id="m-lit" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="560">
      <stop offset="0" style="stop-color: var(--lamp-hi-2)"/>
      <stop offset=".12" style="stop-color: var(--lamp-hi)"/>
      <stop offset=".3" style="stop-color: var(--lamp); stop-opacity: .4"/>
      <stop offset=".58" stop-color="#1d2029"/>
      <stop offset="1" stop-color="#101217"/>
    </radialGradient>
    <radialGradient id="m-body" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="620">
      <stop offset="0" style="stop-color: var(--lamp); stop-opacity: .28"/>
      <stop offset=".3" stop-color="#14161d"/>
      <stop offset="1" stop-color="#07080b"/>
    </radialGradient>
  </defs>
  <path class="m-body" fill="url(#m-body)" d="M-486 ${H} L-452 92 Q-446 54 -404 52 L404 52 Q446 54 452 92 L486 ${H} Z"/>
  <path class="m-edge" fill="none" stroke="url(#m-lit)" stroke-width="3" d="M-452 92 Q-446 54 -404 52 L404 52 Q446 54 452 92"/>
  <g class="m-spools" fill="#0c0e13" stroke="url(#m-lit)" stroke-width="3">
    <circle cx="-318" cy="104" r="54"/><circle cx="-318" cy="104" r="17"/>
    <circle cx="318" cy="104" r="54"/><circle cx="318" cy="104" r="17"/>
  </g>
  <path class="m-basket" fill="#06070a" d="M-214 ${BASKET_Y} A214 214 0 0 0 214 ${BASKET_Y} Z"/>
  <g class="m-bars" stroke="url(#m-lit)" stroke-width="3.5" stroke-linecap="round">${typeBars()}</g>
  <path class="m-segment" fill="none" stroke="url(#m-lit)" stroke-width="7" d="M-64 ${BASKET_Y} A64 64 0 0 0 64 ${BASKET_Y}"/>
  <rect class="m-guide" x="-15" y="4" width="30" height="15" rx="3"/>
  <g class="m-keys" fill="#0d0f14" stroke="url(#m-lit)" stroke-width="3">${k.caps}</g>
  <g class="m-glints">${k.glints}
    <circle cx="-58" cy="${BASKET_Y + 12}" r="4"/><circle cx="58" cy="${BASKET_Y + 12}" r="4"/>
    <circle cx="-30" cy="${BASKET_Y + 58}" r="3.5" opacity=".8"/><circle cx="30" cy="${BASKET_Y + 58}" r="3.5" opacity=".8"/>
    <circle cx="-280" cy="62" r="3" opacity=".55"/><circle cx="280" cy="62" r="3" opacity=".55"/>
  </g>
</svg>`;
}
