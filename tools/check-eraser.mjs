// Ластик: стирает куски линий, фигуры целиком, крупнее кисти, виден всем.
import { chromium } from 'playwright-chromium';
import { roomFingerprint } from '../js/sync-firebase.js';
import { FIREBASE } from '../js/firebase-config.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:20300/index.html';
const ROOM = 'Ластик ' + process.pid, KEY = 'k' + process.pid, DMKEY = 'm' + process.pid;
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
dm.once('dialog', (d) => d.accept('Зал'));
await dm.click('#btn-add-location');
await dm.waitForTimeout(1200);

const pl = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage(); watch(pl, 'PL');
await pl.goto(`${BASE}?${q({ r: ROOM, k: KEY })}`);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(2500);

const b = await dm.locator('#board').boundingBox();
const s2 = (x, y) => dm.evaluate(({ x, y }) => window.__board().worldToScreen(x, y), { x, y });

/* длинная линия пером через всё поле + круг рядом */
await dm.click('[data-tool="draw"]');
await dm.click('#draw-shapes .shape:nth-child(1)');           // перо
const p1 = await s2(-300, 0), p2 = await s2(300, 0);
await dm.mouse.move(b.x + p1.x, b.y + p1.y);
await dm.mouse.down();
await dm.mouse.move(b.x + p2.x, b.y + p2.y, { steps: 40 });
await dm.mouse.up();
await dm.click('#draw-shapes .shape:nth-child(6)');           // круг
const c1 = await s2(0, -220), c2 = await s2(90, -220);
await dm.mouse.move(b.x + c1.x, b.y + c1.y);
await dm.mouse.down();
await dm.mouse.move(b.x + c2.x, b.y + c2.y, { steps: 8 });
await dm.mouse.up();
await dm.waitForTimeout(600);
R.до = await dm.evaluate(() => {
  const d = window.__state().locations[window.__state().activeLoc].drawings;
  return { штрихов: d.length, видыФигур: d.map((x) => x.shape) };
});

/* ластик заметно крупнее кисти */
await dm.click('#draw-shapes .shape:nth-child(8)');           // ластик
await dm.waitForTimeout(300);
R.размеры = await dm.evaluate(() => ({
  ластикРадиус: window.__board().eraseSize(),
  кистьТолщина: Number(document.querySelector('#draw-width').value),
  показанСвойПолзунок: !document.querySelector('#erase-size-row').hidden
    && document.querySelector('#draw-width-row').hidden,
}));

/* стираем середину линии */
const m1 = await s2(-40, 0), m2 = await s2(40, 0);
await dm.mouse.move(b.x + m1.x, b.y + m1.y);
await dm.mouse.down();
await dm.mouse.move(b.x + m2.x, b.y + m2.y, { steps: 10 });
await dm.mouse.up();
await dm.waitForTimeout(800);
R.послеСтиранияСередины = await dm.evaluate(() => {
  const d = window.__state().locations[window.__state().activeLoc].drawings;
  const pen = d.filter((x) => x.shape === 'pen');
  return {
    кусковЛинии: pen.length,
    точекВКусках: pen.map((x) => x.pts.length),
    кругНаМесте: d.some((x) => x.shape === 'circle'),
  };
});
await pl.waitForTimeout(2000);
R.уИгрока = await pl.evaluate(() => {
  const d = window.__state().locations[window.__state().activeLoc].drawings;
  return { всего: d.length, кусковЛинии: d.filter((x) => x.shape === 'pen').length };
});
await dm.screenshot({ path: 'tools/shot-eraser.png' });

/* задеваем круг — он должен исчезнуть целиком */
const e1 = await s2(90, -220);
await dm.mouse.move(b.x + e1.x, b.y + e1.y);
await dm.mouse.down();
await dm.mouse.move(b.x + e1.x + 10, b.y + e1.y + 6, { steps: 4 });
await dm.mouse.up();
await dm.waitForTimeout(700);
R.послеКруга = await dm.evaluate(() => {
  const d = window.__state().locations[window.__state().activeLoc].drawings;
  return { кругОстался: d.some((x) => x.shape === 'circle'), всего: d.length };
});

R.ошибки = errors;
console.log(JSON.stringify(R, null, 2));
await browser.close();
const slug = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
await fetch(`${FIREBASE.databaseURL}/rooms/${encodeURIComponent(slug + '-' + roomFingerprint(slug, KEY))}.json`, { method: 'DELETE' });
