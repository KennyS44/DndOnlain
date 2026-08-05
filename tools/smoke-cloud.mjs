// Проверка облачного режима: Мастер и игрок сидят в РАЗНЫХ браузерных
// профилях (как на разных устройствах) и должны видеть одно и то же.
import { chromium } from 'playwright-chromium';
import zlib from 'node:zlib';
import { roomFingerprint } from '../js/sync-firebase.js';
import { FIREBASE } from '../js/firebase-config.js';

/* ── картинки для загрузки ── */
let T = null;
function crc32(buf) {
  if (!T) { T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
  let c = 0xffffffff;
  for (const b of buf) c = T[(c ^ b) & 255] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
const png = (w, h, rgb) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0] ^ (x & 31); raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2] ^ (y & 31);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const file = (name, buf) => ({ name, mimeType: 'image/png', buffer: buf });

const URL_ = 'http://127.0.0.1:20300/index.html';
const ROOM = 'Проверка ' + process.pid;
const KEY = 'players-' + process.pid;
const DMKEY = 'master-' + process.pid;
const errors = [];
const watch = (p, tag) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(tag + ' console: ' + m.text()));
  p.on('pageerror', (e) => errors.push(tag + ' error: ' + e.message));
};

const browser = await chromium.launch();

/* ── Мастер ── */
const ctxDM = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const dm = await ctxDM.newPage(); watch(dm, 'DM');
await dm.goto(URL_);
await dm.click('[data-gate-tab="create"]');
await dm.fill('#create-form [name=name]', 'Мастер');
await dm.fill('#create-form [name=room]', ROOM);
await dm.fill('#create-form [name=key]', KEY);
await dm.fill('#create-form [name=dmkey]', DMKEY);
await dm.click('#create-form button[type=submit]');
await dm.waitForSelector('#app:not([hidden])', { timeout: 20000 });

dm.once('dialog', (d) => d.accept('Таверна'));
await dm.click('#btn-add-location');
await dm.waitForSelector('#locations-list .list-item');
await dm.setInputFiles('#locations-list .list-item input[type=file]', file('map.png', png(600, 400, [60, 55, 45])));
await dm.waitForTimeout(1500);

await dm.click('[data-ltab="library"]');
await dm.setInputFiles('#lib-upload', file('hero.png', png(64, 64, [130, 160, 95])));
await dm.waitForSelector('#lib-grid .lib-item');
await dm.dblclick('#lib-grid .lib-item');
await dm.waitForTimeout(1500);

/* ── Игрок в отдельном профиле ── */
const ctxPL = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const pl = await ctxPL.newPage(); watch(pl, 'PL');
await pl.goto(URL_);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.fill('#join-form [name=room]', ROOM);
await pl.fill('#join-form [name=key]', KEY);
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(2500);

const seenByPlayer = await pl.evaluate(() => {
  const s = window.__state();
  return {
    locations: Object.values(s.locations).map((l) => l.name),
    mapLoaded: !!Object.values(s.locations)[0]?.assetId,
    tokens: Object.values(s.tokens).length,
    isDM: !!document.querySelector('#panel-left'),
  };
});

/* неверный ключ не должен пускать */
const ctxBad = await browser.newContext();
const bad = await ctxBad.newPage();
await bad.goto(URL_);
await bad.fill('#join-form [name=name]', 'Чужак');
await bad.fill('#join-form [name=room]', ROOM);
await bad.fill('#join-form [name=key]', 'не-тот-ключ');
await bad.click('#join-form button[type=submit]');
await bad.waitForTimeout(4000);
const strangerBlocked = await bad.evaluate(() => document.querySelector('#app').hidden);

/* ── обмен: чат, бросок, движение токена ── */
await pl.fill('#chat-input', 'Я в игре');
await pl.press('#chat-input', 'Enter');
await dm.waitForFunction(() => [...document.querySelectorAll('#chat-feed .body')].some((n) => n.textContent.includes('Я в игре')), null, { timeout: 15000 })
  .catch(() => errors.push('Мастер не получил сообщение игрока'));

await dm.click('#btn-dice');
await dm.click('#dice-buttons .die-btn:nth-child(6)');
await pl.waitForSelector('.die', { timeout: 15000 }).catch(() => errors.push('Игрок не увидел бросок Мастера'));

const before = await pl.evaluate(() => Object.values(window.__state().tokens)[0].x);
const box = await dm.locator('#board').boundingBox();
await dm.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await dm.mouse.down();
await dm.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 60, { steps: 10 });
await dm.mouse.up();
await pl.waitForFunction((x0) => Object.values(window.__state().tokens)[0].x !== x0, before, { timeout: 15000 })
  .catch(() => errors.push('Игрок не увидел перемещение токена'));

/* ── перезаход: состояние живёт в облаке ── */
await ctxPL.clearCookies();
const ctxNew = await browser.newContext();
const again = await ctxNew.newPage(); watch(again, 'RE');
await again.goto(URL_);
await again.fill('#join-form [name=name]', 'Торин');
await again.fill('#join-form [name=room]', ROOM);
await again.fill('#join-form [name=key]', KEY);
await again.click('#join-form button[type=submit]');
await again.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await again.waitForTimeout(2500);
const afterRejoin = await again.evaluate(() => ({
  tokens: Object.values(window.__state().tokens).length,
  chat: window.__state().chat.length,
  map: !!Object.values(window.__state().locations)[0]?.assetId,
}));
await again.screenshot({ path: 'tools/shot-cloud-player.png' });
await dm.screenshot({ path: 'tools/shot-cloud-dm.png' });

console.log(JSON.stringify({ seenByPlayer, strangerBlocked, afterRejoin, errors }, null, 2));
await browser.close();

/* ── убираем тестовую комнату из базы ── */
const path = 'проверка-' + process.pid;
const slugRoom = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
const full = slugRoom + '-' + roomFingerprint(slugRoom, KEY);
const res = await fetch(`${FIREBASE.databaseURL}/rooms/${encodeURIComponent(full)}.json`, { method: 'DELETE' });
console.log('очистка тестовой комнаты:', res.status, path === full ? '' : full);
