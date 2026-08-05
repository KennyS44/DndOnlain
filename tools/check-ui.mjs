// Проверка правок: картинка для игроков, режим «только фигурки»,
// диагональ линейки, читаемость подписей, складные настройки.
import { chromium } from 'playwright-chromium';
import zlib from 'node:zlib';
import { roomFingerprint } from '../js/sync-firebase.js';
import { FIREBASE } from '../js/firebase-config.js';

let T = null;
function crc32(b) {
  if (!T) { T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
  let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return c ^ 0xffffffff;
}
const png = (w, h, rgb) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = rgb[0] ^ (x & 15); raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2] ^ (y & 15);
  }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const body = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([l, body, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const img = (n, b) => ({ name: n, mimeType: 'image/png', buffer: b });

const BASE = process.env.BASE_URL || 'http://127.0.0.1:20300/index.html';
const ROOM = 'UI ' + process.pid, KEY = 'k' + process.pid, DMKEY = 'm' + process.pid;
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

dm.once('dialog', (d) => d.accept('Зал'));
await dm.click('#btn-add-location');
await dm.waitForSelector('#locations-list .list-item');
await dm.setInputFiles('#locations-list .list-item input[type=file]', img('map.png', png(800, 600, [58, 54, 44])));
await dm.waitForTimeout(1200);

/* 1. складные настройки: по умолчанию закрыты, открываются и запоминаются */
R.folds = await dm.evaluate(() => {
  const f = [...document.querySelectorAll('.fold')];
  const stack = document.querySelector('.settings-stack').getBoundingClientRect();
  const list = document.querySelector('#locations-list').getBoundingClientRect();
  const panel = document.querySelector('#panel-left').getBoundingClientRect();
  return { сколько: f.length, закрытыПоУмолчанию: f.every((x) => !x.open),
    подСписком: stack.top >= list.bottom - 1,
    прижатыКНизу: panel.bottom - stack.bottom < 40 };
});
await dm.click('.fold[data-fold="grid"] summary');
await dm.waitForTimeout(200);
R.folds.открылся = await dm.evaluate(() => document.querySelector('.fold[data-fold="grid"]').open);
await dm.reload();
await dm.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await dm.waitForTimeout(1500);
R.folds.запомнилПослеПерезагрузки = await dm.evaluate(() => document.querySelector('.fold[data-fold="grid"]').open);

/* 2. картинка для игроков */
const pl = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage(); watch(pl, 'PL');
await pl.goto(`${BASE}?${q({ r: ROOM, k: KEY })}`);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(2000);

await dm.click('[data-rtab="pics"]');
await dm.setInputFiles('#pics-upload', img('scene.png', png(400, 300, [96, 74, 52])));
await dm.waitForSelector('#pics-grid .lib-item');
await dm.click('#pics-grid .lib-item');
await pl.waitForSelector('#showcase:not([hidden])', { timeout: 15000 }).catch(() => errors.push('игрок не увидел картинку'));
R.картинка = {
  уИгрока: await pl.evaluate(() => !document.querySelector('#showcase').hidden),
  подписьУМастера: await dm.textContent('#showcase-label'),
  подписьУИгрока: await pl.textContent('#showcase-label'),
};
await pl.click('#showcase-close');
await pl.waitForTimeout(300);
R.картинка.свернулась = await pl.evaluate(() => document.querySelector('#showcase').hidden
  && !document.querySelector('#showcase-chip').hidden);
await pl.click('#showcase-chip');
await pl.waitForTimeout(300);
R.картинка.вернулась = await pl.evaluate(() => !document.querySelector('#showcase').hidden);
await pl.screenshot({ path: 'tools/shot-showcase.png' });
await dm.click('#showcase-off');
await pl.waitForTimeout(1500);
R.картинка.убралосьУВсех = await pl.evaluate(() => document.querySelector('#showcase').hidden
  && document.querySelector('#showcase-chip').hidden);

/* 3. линейка по диагонали: 3 клетки вправо + 4 вниз = 5 клеток = 25 футов */
await dm.evaluate(() => {
  const s = window.__state();
  window.__dispatch({ t: 'loc.update', id: s.activeLoc, patch: { grid: { size: 70, ox: 0, oy: 0, feet: 5, show: true } } });
  window.__board().fit();
});
await dm.click('[data-tool="ruler"]');
const box = await dm.locator('#board').boundingBox();
const p0 = await dm.evaluate(() => window.__board().worldToScreen(0, 0));
const p1 = await dm.evaluate(() => window.__board().worldToScreen(210, 280));  // 3 и 4 клетки
await dm.mouse.move(box.x + p0.x, box.y + p0.y);
await dm.mouse.down();
await dm.mouse.move(box.x + p1.x, box.y + p1.y, { steps: 10 });
R.линейка = await dm.evaluate(() => window.__ruler && window.__ruler());
await dm.screenshot({ path: 'tools/shot-ruler.png' });
await dm.mouse.up();

/* 4. режим «только фигурки»: карта не сдвигается, фигурка двигается */
await dm.click('[data-ltab="library"]');
await dm.setInputFiles('#lib-upload', img('hero.png', png(64, 64, [120, 160, 90])));
await dm.waitForSelector('#lib-grid .lib-item');
await dm.dblclick('#lib-grid .lib-item');
await dm.waitForTimeout(600);
await dm.click('[data-tool="token"]');
const viewBefore = await dm.evaluate(() => ({ ...window.__board().view() }));
await dm.mouse.move(box.x + 80, box.y + 80);          // пустое место
await dm.mouse.down();
await dm.mouse.move(box.x + 300, box.y + 300, { steps: 10 });
await dm.mouse.up();
const viewAfter = await dm.evaluate(() => ({ ...window.__board().view() }));
const tokPos = await dm.evaluate(() => {
  const t = Object.values(window.__state().tokens)[0];
  return window.__board().worldToScreen(t.x, t.y);
});
const tokBefore = await dm.evaluate(() => Object.values(window.__state().tokens)[0].x);
await dm.mouse.move(box.x + tokPos.x, box.y + tokPos.y);
await dm.mouse.down();
await dm.mouse.move(box.x + tokPos.x + 210, box.y + tokPos.y, { steps: 10 });
await dm.mouse.up();
await dm.waitForTimeout(400);
R.толькоФигурки = {
  картаНеСдвинулась: viewBefore.x === viewAfter.x && viewBefore.y === viewAfter.y,
  фигуркаСдвинулась: await dm.evaluate((a) => Object.values(window.__state().tokens)[0].x !== a, tokBefore),
};

/* 5. очистка чата и журнала бросков — по отдельности и у всех */
const счёт = (page) => page.evaluate(() => ({
  чат: document.querySelectorAll('#chat-feed .msg').length,
  броски: document.querySelectorAll('#rolls-feed .msg').length,
}));
await pl.fill('#chat-input', 'слово игрока');
await pl.press('#chat-input', 'Enter');
await pl.click('#btn-dice');
await pl.click('#dice-buttons .die-btn:nth-child(6)');
await dm.waitForTimeout(2500);
R.очистка = { доОчистки: await счёт(pl) };

dm.once('dialog', (d) => d.accept());
await dm.click('[data-rtab="rolls"]');
await dm.click('#rolls-clear');
await pl.waitForTimeout(2500);
R.очистка.послеОчисткиБросков = await счёт(pl);

dm.once('dialog', (d) => d.accept());
await dm.click('[data-rtab="chat"]');
await dm.click('#chat-clear');
await pl.waitForTimeout(2500);
R.очистка.послеОчисткиЧата = await счёт(pl);
R.очистка.кнопкиУИгрокаНет = await pl.evaluate(() => !document.querySelector('#chat-clear') && !document.querySelector('#rolls-clear'));

R.errors = errors;
console.log(JSON.stringify(R, null, 2));
await browser.close();

const slug = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
await fetch(`${FIREBASE.databaseURL}/rooms/${encodeURIComponent(slug + '-' + roomFingerprint(slug, KEY))}.json`, { method: 'DELETE' });
