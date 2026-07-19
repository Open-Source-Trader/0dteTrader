// Generates the .hud-card border-image data-URIs for hud.css.
// SVG master: 96x96, glow margin m=8, chamfer c=10.
// border-image: <uri> 28 fill / 28px / 8px stretch  (28 = m + c + 10 edge)

const M = 8; // glow margin
const C = 10; // chamfer
const S = 96; // svg size

function panelPath() {
  const a = M; // outer edge of panel
  const b = S - M;
  return `M${a + C} ${a} H${b - C} L${b} ${a + C} V${b - C} L${b - C} ${b} H${a + C} L${a} ${b - C} V${a + C} Z`;
}

// Corner tick marks: short accent strokes hugging each chamfer edge, just
// outside the main stroke — the mockups' "notched corner" detail.
function ticks() {
  const a = M - 2.5;
  const b = S - M + 2.5;
  const t = C + 4;
  return [
    `M${a + t} ${a} L${a} ${a + t}`,
    `M${b - t} ${a} L${b} ${a + t}`,
    `M${b} ${b - t} L${b - t} ${b}`,
    `M${a} ${b - t} L${a + t} ${b}`,
  ].join(' ');
}

function svg({ stroke, glow, fill, highlight, glowOpacity, strokeWidth, withTicks }) {
  const p = panelPath();
  const glowLayer = glowOpacity
    ? `<path d='${p}' fill='none' stroke='${glow}' stroke-width='2.5' opacity='${glowOpacity}' filter='url(%23b)'/>`
    : '';
  const tickLayer = withTicks
    ? `<path d='${ticks()}' fill='none' stroke='${stroke}' stroke-width='1.2' opacity='0.55'/>`
    : '';
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${S}' height='${S}'>` +
    (glowOpacity ? `<filter id='b' x='-30%25' y='-30%25' width='160%25' height='160%25'><feGaussianBlur stdDeviation='3.2'/></filter>` : '') +
    `<clipPath id='c'><path d='${p}'/></clipPath>` +
    `<linearGradient id='h' x1='0' y1='0' x2='0' y2='1'>` +
    `<stop offset='0' stop-color='${highlight}'/><stop offset='1' stop-color='${highlight}' stop-opacity='0'/>` +
    `</linearGradient>` +
    glowLayer +
    `<path d='${p}' fill='${fill}'/>` +
    `<rect x='${M}' y='${M}' width='${S - 2 * M}' height='18' fill='url(%23h)' clip-path='url(%23c)'/>` +
    `<path d='${p}' fill='none' stroke='${stroke}' stroke-width='${strokeWidth}'/>` +
    tickLayer +
    `</svg>`
  );
}

function uri(s) {
  return `url("data:image/svg+xml,${s.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/'/g, "%27")}")`;
}

const FILL = '%23081020eb'; // hud panel fill ~0.92
const HILITE = '%23a0d2ff38'; // inner top highlight ~0.22

const variants = {
  accent: { stroke: '%232e8fff', glow: '%233b9eff', glowOpacity: 0.85, strokeWidth: 1.5, withTicks: true },
  buy: { stroke: '%2322e06a', glow: '%2322e06a', glowOpacity: 0.8, strokeWidth: 1.5, withTicks: true },
  sell: { stroke: '%23ff3b4e', glow: '%23ff3b4e', glowOpacity: 0.8, strokeWidth: 1.5, withTicks: true },
  warn: { stroke: '%23ffc53d', glow: '%23ffc53d', glowOpacity: 0.75, strokeWidth: 1.5, withTicks: true },
  flat: { stroke: '%232e8fff8c', glow: '', glowOpacity: 0, strokeWidth: 1.3, withTicks: false },
};

const lines = [':root {'];
for (const [name, v] of Object.entries(variants)) {
  const s = svg({ ...v, fill: FILL, highlight: HILITE });
  lines.push(`  --hud-src-${name}: ${uri(s)};`);
}
lines.push('}\n');
for (const name of Object.keys(variants)) {
  lines.push(`.hud-card--${name} {\n  --hud-border-src: var(--hud-src-${name});\n}\n`);
}
console.log(lines.join('\n'));
