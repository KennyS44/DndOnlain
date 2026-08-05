// Кубики: бросок + анимация летящего куба, которую видят все за столом.

export const DICE = [4, 6, 8, 10, 12, 20, 100];

export function roll(sides, count = 1, mod = 0, adv = null) {
  const rnd = () => 1 + Math.floor(Math.random() * sides);
  let dice = Array.from({ length: count }, rnd);
  let dropped = null;
  if (adv && sides === 20) {
    const pair = [rnd(), rnd()];
    const keep = adv === 'adv' ? Math.max(...pair) : Math.min(...pair);
    dropped = pair.filter((v, i) => pair.indexOf(keep) !== i || v !== keep);
    dice = [keep];
  }
  const sum = dice.reduce((a, b) => a + b, 0);
  return {
    sides, count: dice.length, mod, adv,
    dice, dropped, total: sum + mod,
    formula: `${dice.length}d${sides}${mod ? (mod > 0 ? '+' + mod : mod) : ''}${adv ? (adv === 'adv' ? ' (преим.)' : ' (помеха)') : ''}`,
  };
}

/** Показывает бросок поверх всего: куб летит, замирает на 5 секунд, тает. */
export function playAnimation(stage, result, caption) {
  const box = document.createElement('div');
  box.className = 'die-throw';
  stage.appendChild(box);

  const n = Math.min(result.dice.length, 8);
  const spread = Math.min(window.innerWidth * .7, n * 104);

  result.dice.slice(0, n).forEach((val, i) => {
    const die = document.createElement('div');
    die.className = 'die3d';
    const left = window.innerWidth / 2 - spread / 2 + (spread / n) * i + (spread / n - 84) / 2;
    die.style.left = left + 'px';
    die.style.top = (window.innerHeight / 2 - 90) + 'px';
    die.style.setProperty('--fx', (i - n / 2) * 60 + 'px');
    die.style.animationDelay = (i * 70) + 'ms';
    die.innerHTML = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']
      .map((f) => `<div class="face ${f}">${f === 'f1' ? val : rndFace(result.sides)}</div>`).join('');
    box.appendChild(die);
  });

  const res = document.createElement('div');
  res.className = 'die-result';
  res.style.top = 'calc(50% + 110px)';
  res.innerHTML = `<div class="total-big">${result.total}</div><div class="caption">${caption}</div>`;
  res.style.opacity = '0';
  box.appendChild(res);

  const settle = 1150 + n * 70;
  setTimeout(() => { res.style.transition = 'opacity .3s ease'; res.style.opacity = '1'; }, settle);
  setTimeout(() => {
    box.style.transition = 'opacity .6s ease';
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 700);
  }, settle + 5000);
}

function rndFace(sides) { return 1 + Math.floor(Math.random() * sides); }
