// Клик по двери вне режима стен + внешний вид перерисованных элементов.
import { chromium } from 'playwright-chromium';
import { roomFingerprint } from '../js/sync-firebase.js';
import { FIREBASE } from '../js/firebase-config.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:20300/index.html';
const ROOM = 'Вид ' + process.pid, KEY = 'k' + process.pid, DMKEY = 'm' + process.pid;
const q = (o) => new URLSearchParams(o).toString();
const R = {}; const errors = [];
const watch = (p, t) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(t + ': ' + m.text()));
  p.on('pageerror', (e) => errors.push(t + ': ' + e.message));
};

const browser = await chromium.launch();
const dm = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage(); watch(dm, 'DM');
await dm.goto(`${BASE}?${q({ r: ROOM, k: KEY, m: DMKEY })}`);
await dm.fill('#join-form [name=name]', 'Мастер');
await dm.click('#join-form button[type=submit]');
await dm.waitForSelector('#app:not([hidden])', { timeout: 20000 });
dm.once('dialog', (d) => d.accept('Крипта'));
await dm.click('#btn-add-location');
await dm.waitForTimeout(1000);

await dm.evaluate(() => {
  const s = window.__state();
  window.__dispatch({ t: 'loc.update', id: s.activeLoc, patch: { fogOn: true } });
  window.__dispatch({ t: 'wall.add', locId: s.activeLoc, wall: { id: 'w1', type: 'wall', open: false, x1: -280, y1: -140, x2: 140, y2: -140 } });
  window.__dispatch({ t: 'wall.add', locId: s.activeLoc, wall: { id: 'd1', type: 'door', open: false, x1: 140, y1: -140, x2: 140, y2: 70 } });
  window.__dispatch({ t: 'token.add', token: { id: 'г', locId: s.activeLoc, x: -70, y: 0, cells: 1, name: 'Торин', kind: 'pc', assetId: null, ownerName: 'Торин', ownerId: null, hp: { cur: 9, max: 12 }, hpPublic: true, statuses: [], vision: 60 } });
  window.__board().fit();
});
await dm.waitForTimeout(800);

/* КЛИК ПО ДВЕРИ В ОБЫЧНОМ РЕЖИМЕ */
const b = await dm.locator('#board').boundingBox();
const doorMid = await dm.evaluate(() => window.__board().worldToScreen(140, -35));
const дверь = () => dm.evaluate(() => window.__state().locations[window.__state().activeLoc].walls.find((w) => w.id === 'd1').open);
R.дверь = { доКлика: await дверь(), инструмент: await dm.evaluate(() => document.querySelector('#toolbar .tool.is-active').dataset.tool) };
await dm.mouse.move(b.x + doorMid.x, b.y + doorMid.y);
await dm.waitForTimeout(200);
R.дверь.курсорПодсказка = await dm.evaluate(() => document.querySelector('#board').classList.contains('on-door'));
await dm.mouse.click(b.x + doorMid.x, b.y + doorMid.y);
await dm.waitForTimeout(600);
R.дверь.послеКликаВРежимеВыбора = await дверь();
await dm.mouse.click(b.x + doorMid.x, b.y + doorMid.y);
await dm.waitForTimeout(600);
R.дверь.второйКликЗакрыл = !(await дверь());

/* в режиме «только фигурки» тоже */
await dm.click('[data-tool="token"]');
await dm.mouse.click(b.x + doorMid.x, b.y + doorMid.y);
await dm.waitForTimeout(600);
R.дверь.вРежимеФигурок = await дверь();
await dm.evaluate(() => window.__dispatch({ t: 'wall.update', locId: window.__state().activeLoc, id: 'd1', patch: { open: false } }));
await dm.click('[data-tool="select"]');
await dm.waitForTimeout(400);

/* перетаскивание фигурки рядом с дверью не должно её открывать */
const tp = await dm.evaluate(() => window.__board().worldToScreen(-70, 0));
await dm.mouse.move(b.x + tp.x, b.y + tp.y);
await dm.mouse.down();
await dm.mouse.move(b.x + tp.x + 60, b.y + tp.y + 20, { steps: 8 });
await dm.mouse.up();
await dm.waitForTimeout(500);
R.дверь.неОткрыласьОтПеретаскивания = !(await дверь());
await dm.screenshot({ path: 'tools/shot-skin-walls.png' });

/* ВИД: самоцвет и строки героев */
const pl = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage(); watch(pl, 'PL');
await pl.goto(`${BASE}?${q({ r: ROOM, k: KEY })}`);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(2500);
await dm.click('[data-rtab="heroes"]');
await dm.waitForTimeout(300);
await dm.evaluate(() => [...document.querySelectorAll('#heroes-list .hero-btn')].at(-1).click());
await pl.waitForTimeout(1500);
R.самоцвет = await pl.evaluate(() => {
  const g = document.querySelector('#gem-badge .gem svg use');
  const r = document.querySelector('#gem-badge .gem').getBoundingClientRect();
  return { гранёныйSVG: !!g, ширина: Math.round(r.width), высота: Math.round(r.height),
           число: document.querySelector('#gem-count').textContent };
});
R.строкаГероя = await dm.evaluate(() => {
  const row = document.querySelector('#heroes-list .hero-row');
  return { есть: !!row, самоцветВСтроке: !!row.querySelector('.gem svg use'),
           фактура: getComputedStyle(row).backgroundImage.split('url').length > 0 };
});
await dm.locator('.panel-right').screenshot({ path: 'tools/shot-skin-heroes.png' });

/* ВИД: эффект страха и оков */
for (const [st, file] of [['Испуган', 'fear'], ['Обездвижен', 'hold'], ['Благословлён', 'bless']]) {
  await dm.evaluate((x) => window.__dispatch({ t: 'token.status', id: 'г', statuses: [x] }), st);
  await pl.waitForTimeout(1300);
  await pl.locator('#board-wrap').screenshot({ path: `tools/shot-skin-${file}.png` });
}
R.эффектыБезОшибок = errors.length === 0;

R.ошибки = errors;
console.log(JSON.stringify(R, null, 2));
await browser.close();
const slug = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
await fetch(`${FIREBASE.databaseURL}/rooms/${encodeURIComponent(slug + '-' + roomFingerprint(slug, KEY))}.json`, { method: 'DELETE' });
