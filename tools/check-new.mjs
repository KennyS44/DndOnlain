// Проверка: стены и двери обрезают обзор, самоцвет вдохновения,
// экранные эффекты состояний у игрока.
import { chromium } from 'playwright-chromium';
import { roomFingerprint } from '../js/sync-firebase.js';
import { FIREBASE } from '../js/firebase-config.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:20300/index.html';
const ROOM = 'Новое ' + process.pid, KEY = 'k' + process.pid, DMKEY = 'm' + process.pid;
const q = (o) => new URLSearchParams(o).toString();
const R = {}; const errors = [];
const watch = (p, t) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(t + ': ' + m.text()));
  p.on('pageerror', (e) => errors.push(t + ': ' + e.message));
};

const browser = await chromium.launch();
const dm = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage(); watch(dm, 'DM');
await dm.goto(`${BASE}?${q({ r: ROOM, k: KEY, m: DMKEY })}`);
await dm.fill('#join-form [name=name]', 'Мастер');
await dm.click('#join-form button[type=submit]');
await dm.waitForSelector('#app:not([hidden])', { timeout: 20000 });
dm.once('dialog', (d) => d.accept('Подвал'));
await dm.click('#btn-add-location');
await dm.waitForTimeout(1200);

const pl = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage(); watch(pl, 'PL');
await pl.goto(`${BASE}?${q({ r: ROOM, k: KEY })}`);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(2500);

/* фигурка игрока с обзором + туман */
await dm.evaluate(() => {
  const s = window.__state();
  window.__dispatch({ t: 'loc.update', id: s.activeLoc, patch: { fogOn: true, grid: { size: 70, ox: 0, oy: 0, feet: 5, show: true } } });
  window.__dispatch({
    t: 'token.add',
    token: {
      id: 'герой', locId: s.activeLoc, x: 35, y: 35, cells: 1, name: 'Торин', kind: 'pc',
      assetId: null, ownerName: 'Торин', ownerId: null, hp: { cur: 10, max: 10 }, hpPublic: true,
      statuses: [], vision: 60,
    },
  });
});
await pl.waitForTimeout(2000);

/* 1. СТЕНЫ: обзор должен обрываться */
const обзор = () => dm.evaluate(() => {
  const s = window.__state();
  const t = s.tokens['герой'];
  const pts = window.__board().visionPoints(t);
  // насколько далеко видно строго вправо (первая точка многоугольника)
  return Math.round(Math.hypot(pts[0].x - t.x, pts[0].y - t.y));
});
R.стены = { безСтеныВидноПиксели: await обзор() };
await dm.evaluate(() => {
  const s = window.__state();
  window.__dispatch({
    t: 'wall.add', locId: s.activeLoc,
    wall: { id: 'w1', type: 'wall', open: false, x1: 210, y1: -200, x2: 210, y2: 400 },
  });
});
await dm.waitForTimeout(500);
R.стены.соСтенойВидноПиксели = await обзор();

/* дверь: закрытая держит, открытая пропускает */
await dm.evaluate(() => {
  const s = window.__state();
  window.__dispatch({ t: 'wall.remove', locId: s.activeLoc, id: 'w1' });
  window.__dispatch({
    t: 'wall.add', locId: s.activeLoc,
    wall: { id: 'd1', type: 'door', open: false, x1: 210, y1: -200, x2: 210, y2: 400 },
  });
});
await dm.waitForTimeout(500);
R.стены.закрытаяДверь = await обзор();
await dm.evaluate(() => window.__dispatch({ t: 'wall.update', locId: window.__state().activeLoc, id: 'd1', patch: { open: true } }));
await dm.waitForTimeout(500);
R.стены.открытаяДверь = await обзор();

/* стены видит только Мастер */
R.стены.вСостоянииУИгрока = await pl.evaluate(() => (window.__state().locations[window.__state().activeLoc].walls || []).length);
R.стены.рисуютсяТолькоМастеру = await pl.evaluate(() => {
  // у игрока в отрисовке стены пропускаются: проверяем через сам модуль
  return typeof window.__board().drawsWalls === 'function' ? window.__board().drawsWalls() : 'нет проверки';
});

/* 4. ВДОХНОВЕНИЕ */
await dm.click('[data-rtab="heroes"]');
await dm.waitForTimeout(400);
R.вдохновение = { строкиУМастера: await dm.evaluate(() => [...document.querySelectorAll('#heroes-list .hero-row .who')].map((n) => n.textContent)) };
await dm.evaluate(() => {
  const plus = [...document.querySelectorAll('#heroes-list .hero-btn')].at(-1);
  plus.click();
});
await dm.waitForTimeout(300);
await dm.evaluate(() => [...document.querySelectorAll('#heroes-list .hero-btn')].at(-1).click());
await pl.waitForTimeout(400);
R.вдохновение.уИгрока = await pl.evaluate(() => ({
  самоцветВиден: !document.querySelector('#gem-badge').hidden,
  число: document.querySelector('#gem-count').textContent,
  подсветилось: document.querySelector('#gem-badge').classList.contains('is-changed'),
}));
R.вдохновение.уМастераСамоцветаНет = await dm.evaluate(() => document.querySelector('#gem-badge').hidden);
await dm.evaluate(() => document.querySelectorAll('#heroes-list .hero-btn')[0].click());
await pl.waitForTimeout(2000);
R.вдохновение.послеМинуса = await pl.evaluate(() => document.querySelector('#gem-count').textContent);
await pl.screenshot({ path: 'tools/shot-gem.png' });

/* 5. ЭФФЕКТЫ СОСТОЯНИЙ */
const эффекты = {};
for (const st of ['Ослеплён', 'Испуган', 'Отравлен', 'Оглушён', 'Обездвижен', 'Без сознания', 'Благословлён']) {
  await dm.evaluate((s) => window.__dispatch({ t: 'token.status', id: 'герой', statuses: [s] }), st);
  await pl.waitForTimeout(1200);
  эффекты[st] = await pl.evaluate(() => {
    const l = document.querySelector('#fx-layer');
    const fx = l.querySelector('.fx');
    const r = l.getBoundingClientRect();
    const b = document.querySelector('#board-wrap').getBoundingClientRect();
    return {
      класс: fx ? fx.className.replace('fx fx-', '') : null,
      подпись: l.querySelector('.fx-label span')?.textContent,
      толькоПоле: Math.abs(r.width - b.width) < 2 && Math.abs(r.height - b.height) < 2,
    };
  });
}
R.эффекты = эффекты;
await pl.screenshot({ path: 'tools/shot-fx.png' });

/* у Мастера эффектов быть не должно */
R.эффектовУМастераНет = await dm.evaluate(() => document.querySelectorAll('#fx-layer .fx').length === 0);
await dm.evaluate(() => window.__dispatch({ t: 'token.status', id: 'герой', statuses: [] }));
await pl.waitForTimeout(1200);
R.эффектСнялся = await pl.evaluate(() => document.querySelectorAll('#fx-layer .fx').length === 0);

R.ошибки = errors;
console.log(JSON.stringify(R, null, 2));
await browser.close();

const slug = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
await fetch(`${FIREBASE.databaseURL}/rooms/${encodeURIComponent(slug + '-' + roomFingerprint(slug, KEY))}.json`, { method: 'DELETE' });
