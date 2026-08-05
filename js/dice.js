// Кубики: бросок и анимация. Кубики выглядят как настоящие дайсы D&D —
// у каждого своя форма с гранями, число всегда стоит ровно и читается.

export const DICE = [4, 6, 8, 10, 12, 20, 100];

export function roll(sides, count = 1, mod = 0, adv = null) {
  const rnd = () => 1 + Math.floor(Math.random() * sides);
  let dice = Array.from({ length: count }, rnd);
  if (adv && sides === 20) {
    const pair = [rnd(), rnd()];
    dice = [adv === 'adv' ? Math.max(...pair) : Math.min(...pair)];
  }
  const sum = dice.reduce((a, b) => a + b, 0);
  return {
    sides, mod, adv, dice, total: sum + mod,
    formula: `${dice.length}d${sides}${mod ? (mod > 0 ? '+' + mod : mod) : ''}`
      + (adv ? (adv === 'adv' ? ' с преимуществом' : ' с помехой') : ''),
  };
}

/* ── Силуэты дайсов: контур + рёбра граней ────────────────────────── */
const P = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ');
const poly = (n, r, turn = -90) => Array.from({ length: n }, (_, i) => {
  const a = (turn + (360 / n) * i) * Math.PI / 180;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
});

const SHAPES = {
  4:  () => ({ outline: poly(3, 46, -90), facets: [[[50, 4], [50, 78]], [[11, 73], [50, 78]], [[89, 73], [50, 78]]], ty: 62 }),
  6:  () => ({ outline: [[10, 10], [90, 10], [90, 90], [10, 90]], facets: [], ty: 50, round: 10 }),
  8:  () => ({ outline: [[50, 4], [92, 50], [50, 96], [8, 50]], facets: [[[8, 50], [92, 50]], [[50, 4], [30, 50]], [[50, 4], [70, 50]]], ty: 50 }),
  10: () => ({ outline: [[50, 4], [93, 40], [76, 92], [24, 92], [7, 40]], facets: [[[50, 4], [32, 62]], [[50, 4], [68, 62]], [[32, 62], [68, 62]], [[7, 40], [32, 62]], [[93, 40], [68, 62]]], ty: 54 }),
  12: () => ({ outline: poly(5, 46, -90), facets: poly(5, 22, -90).map((p, i, a) => [p, a[(i + 1) % 5]]).concat(poly(5, 46, -90).map((p, i) => [p, poly(5, 22, -90)[i]])), ty: 52 }),
  20: () => ({ outline: poly(6, 46, -90), facets: poly(3, 26, 90).map((p, i, a) => [p, a[(i + 1) % 3]]).concat(poly(6, 46, -90).filter((_, i) => i % 2 === 0).map((p, i) => [p, poly(3, 26, 90)[i]])), ty: 54 }),
};
SHAPES[100] = SHAPES[10];

function dieSvg(sides, value) {
  const s = (SHAPES[sides] || SHAPES[20])();
  const edges = s.facets.map((e) => `<line x1="${e[0][0]}" y1="${e[0][1]}" x2="${e[1][0]}" y2="${e[1][1]}"/>`).join('');
  const body = s.round
    ? `<rect x="10" y="10" width="80" height="80" rx="${s.round}"/>`
    : `<polygon points="${P(s.outline)}"/>`;
  return `<svg viewBox="0 0 100 100" class="die-svg" aria-hidden="true">
    <g class="die-body">${body}</g>
    <g class="die-edges">${edges}</g>
    <text class="die-num" x="50" y="${s.ty}">${value}</text>
  </svg>`;
}

/** Бросок видят все: кубики влетают, крутятся, замирают на 5 секунд и тают. */
export function playAnimation(stage, result, caption) {
  const box = document.createElement('div');
  box.className = 'die-throw';
  stage.appendChild(box);

  const shown = result.dice.slice(0, 8);
  const gap = 108;
  const width = shown.length * gap;
  const dice = shown.map((val, i) => {
    const d = document.createElement('div');
    d.className = 'die';
    d.style.left = `calc(50% + ${-width / 2 + gap * i + (gap - 96) / 2}px)`;
    d.style.setProperty('--dx', `${(i - (shown.length - 1) / 2) * 90}px`);
    d.style.animationDelay = `${i * 90}ms`;
    d.innerHTML = dieSvg(result.sides, val);
    box.appendChild(d);
    return { node: d, val, at: 900 + i * 90 };
  });

  // пока кубик летит — числа мелькают, в конце встаёт выпавшее
  const started = performance.now();
  const spin = setInterval(() => {
    const t = performance.now() - started;
    let live = false;
    dice.forEach((d) => {
      if (t >= d.at) return;
      live = true;
      d.node.querySelector('.die-num').textContent = 1 + Math.floor(Math.random() * result.sides);
    });
    if (!live) clearInterval(spin);
  }, 70);

  const settle = 900 + (shown.length - 1) * 90 + 260;
  setTimeout(() => {
    clearInterval(spin);
    dice.forEach((d) => {
      d.node.querySelector('.die-num').textContent = d.val;
      d.node.classList.add('is-settled');
    });
  }, settle);

  const res = document.createElement('div');
  res.className = 'die-result';
  res.innerHTML = `<div class="total-big">${result.total}</div><div class="caption">${caption}</div>`;
  box.appendChild(res);
  setTimeout(() => res.classList.add('is-on'), settle);

  setTimeout(() => {
    box.classList.add('is-out');
    setTimeout(() => box.remove(), 600);
  }, settle + 5000);
}
