// Проверка правок: локация на лету, лаги при перетаскивании, кисть тумана,
// подписи дальности, перенос фигурки между локациями.
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
const ROOM = 'Правки ' + process.pid, KEY = 'k' + process.pid, DMKEY = 'm' + process.pid;
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

// стартовая локация + иконка
dm.once('dialog', (d) => d.accept('Таверна'));
await dm.click('#btn-add-location');
await dm.waitForSelector('#locations-list .list-item');
await dm.setInputFiles('#locations-list .list-item input[type=file]', img('map.png', png(900, 700, [58, 54, 44])));
await dm.waitForTimeout(1200);
await dm.click('[data-ltab="library"]');
await dm.setInputFiles('#lib-upload', img('hero.png', png(64, 64, [120, 160, 90])));
await dm.waitForSelector('#lib-grid .lib-item');
await dm.dblclick('#lib-grid .lib-item');
await dm.waitForTimeout(800);

// игрок заходит
const pl = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage(); watch(pl, 'PL');
await pl.goto(`${BASE}?${q({ r: ROOM, k: KEY })}`);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(2500);

/* 8. НОВАЯ ЛОКАЦИЯ ВО ВРЕМЯ СЕССИИ — игрок должен увидеть её и фигурки без перезахода */
dm.once('dialog', (d) => d.accept('Подземелье'));
await dm.click('[data-ltab="locations"]');
await dm.click('#btn-add-location');
await dm.waitForTimeout(1500);
await dm.evaluate(() => {
  const s = window.__state();
  const newLoc = s.order[s.order.length - 1];
  window.__dispatch({ t: 'loc.active', id: newLoc });
  window.__dispatch({
    t: 'token.add',
    token: {
      id: 'новичок', locId: newLoc, x: 200, y: 200, cells: 1, name: 'Скелет', kind: 'enemy',
      assetId: null, ownerName: null, ownerId: null, hp: { cur: 5, max: 5 }, hpPublic: true, statuses: [], vision: 0,
    },
  });
});
await pl.waitForTimeout(3000);
R.новаяЛокацияНаЛету = await pl.evaluate(() => {
  const s = window.__state();
  const l = s.locations[s.activeLoc];
  return {
    активнаяУИгрока: l && l.name,
    видитФигурку: !!s.tokens['новичок'] && s.tokens['новичок'].locId === s.activeLoc,
    полеЖивое: !!(l && l.fog && l.drawings),
  };
});
R.ошибкиУИгрокаПослеЛокации = errors.filter((e) => e.startsWith('PL')).length;

/* 6. ЛАГИ: сколько раз перерисовываются панели за одно перетаскивание */
await pl.evaluate(() => {
  window.__renders = 0;
  const grid = document.querySelector('#chat-feed');
  new MutationObserver(() => { window.__renders++; }).observe(grid, { childList: true });
});
const before = await pl.evaluate(() => performance.now());
await dm.evaluate(async () => {
  const t = Object.values(window.__state().tokens).find((x) => x.id === 'новичок');
  for (let i = 0; i < 25; i++) {
    window.__dispatch({ t: 'token.update', id: t.id, patch: { x: 200 + i * 12, y: 200, mt: Date.now() } });
    await new Promise((r) => setTimeout(r, 80));
  }
});
await pl.waitForTimeout(1500);
R.лаги = await pl.evaluate((t0) => ({
  перерисовокЧатаЗаПеретаскивание: window.__renders,
  кадрыВоВремяДвижения: 'см. ниже',
}), before);

/* 3. КИСТЬ ТУМАНА: размер 1 = одна клетка, режим «прятать» */
await dm.click('[data-ltab="locations"]');
await dm.evaluate(() => {
  const id = window.__state().activeLoc;
  window.__dispatch({ t: 'loc.update', id, patch: { fogOn: true, grid: { size: 70, ox: 0, oy: 0, feet: 5, show: true } } });
  window.__board().fit();
});
await dm.click('.fold[data-fold="fog"] summary').catch(() => {});
await dm.fill('#fog-brush', '1');
await dm.dispatchEvent('#fog-brush', 'input');
await dm.click('[data-tool="fog"]');
const b = await dm.locator('#board').boundingBox();
const p0 = await dm.evaluate(() => window.__board().worldToScreen(35, 35));
await dm.mouse.click(b.x + p0.x, b.y + p0.y);
await dm.waitForTimeout(600);
R.кисть = { открытоКлетокПриРазмере1: await dm.evaluate(() => Object.keys(window.__state().locations[window.__state().activeLoc].fog).length) };

await dm.click('[data-fogmode="hide"]');
await dm.mouse.click(b.x + p0.x, b.y + p0.y);
await dm.waitForTimeout(600);
R.кисть.послеРежимаПрятать = await dm.evaluate(() => Object.keys(window.__state().locations[window.__state().activeLoc].fog).length);
await dm.click('[data-fogmode="reveal"]');
await dm.click('[data-tool="select"]');

/* 2. ПОДПИСЬ ДАЛЬНОСТИ не должна лежать на иконке */
// ставим фигурку в центр холста, подальше от панели рисования
const центр = await dm.evaluate(() => {
  const b = document.querySelector('#board').getBoundingClientRect();
  const w = window.__board().screenToWorld(b.width / 2, b.height / 2 - 80);
  window.__dispatch({ t: 'token.update', id: 'новичок', patch: { x: w.x, y: w.y, cells: 2 } });
  return window.__board().worldToScreen(w.x, w.y);
});
await dm.waitForTimeout(300);
await dm.click('[data-tool="draw"]');
await dm.click('#draw-shapes .shape:nth-child(6)');   // круг
await dm.mouse.move(b.x + центр.x, b.y + центр.y);
await dm.mouse.down();
await dm.mouse.move(b.x + центр.x + 150, b.y + центр.y - 40, { steps: 8 });
await dm.mouse.up();
await dm.waitForTimeout(400);
R.подписьДальности = await dm.evaluate(() => {
  const s = window.__state();
  const d = s.locations[s.activeLoc].drawings.at(-1);
  const t = s.tokens['новичок'];
  const g = s.locations[s.activeLoc].grid;
  const радиусМира = Math.hypot(d.pts[1].x - d.pts[0].x, d.pts[1].y - d.pts[0].y);
  return {
    фигура: d.shape,
    радиусКлеток: +(радиусМира / g.size).toFixed(1),
    // подпись рисуется над краем круга — проверяем, что это выше иконки
    подписьВышеИконкиНаПикселей: Math.round((радиусМира + 16 / window.__board().view().scale) - (g.size * t.cells) / 2),
  };
});
await dm.screenshot({ path: 'tools/shot-radius.png' });
await dm.click('[data-tool="select"]');

/* 7. ПЕРЕНОС ФИГУРКИ МЕЖДУ ЛОКАЦИЯМИ */
const позиция = await dm.evaluate(() => {
  const t = window.__state().tokens['новичок'];
  return window.__board().worldToScreen(t.x, t.y);
});
await dm.mouse.dblclick(b.x + позиция.x, b.y + позиция.y);
await dm.waitForTimeout(400);
R.переносМеждуЛокациями = await dm.evaluate(() => {
  const sel = [...document.querySelectorAll('#token-card select')].at(-1);
  return { естьВыборЛокации: !!sel && sel.options.length === 2, варианты: sel ? [...sel.options].map((o) => o.text) : [] };
});
if (R.переносМеждуЛокациями.естьВыборЛокации) {
  await dm.evaluate(() => {
    const sel = [...document.querySelectorAll('#token-card select')].at(-1);
    sel.value = [...sel.options].find((o) => !o.selected).value;
    sel.dispatchEvent(new Event('change'));
  });
  await dm.waitForTimeout(1200);
  R.переносМеждуЛокациями.фигуркаПереехала = await dm.evaluate(() => {
    const s = window.__state();
    const t = s.tokens['новичок'];
    return { локация: s.locations[t.locId].name, клетка: [Math.floor(t.x / 70), Math.floor(t.y / 70)] };
  });
}

R.ошибки = errors;
console.log(JSON.stringify(R, null, 2));
await browser.close();

const slug = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
await fetch(`${FIREBASE.databaseURL}/rooms/${encodeURIComponent(slug + '-' + roomFingerprint(slug, KEY))}.json`, { method: 'DELETE' });
