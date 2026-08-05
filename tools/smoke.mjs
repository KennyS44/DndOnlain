// Проверка стола в настоящем браузере: заходим Мастером, собираем локацию,
// ставим токен, бросаем кубик и следим за ошибками консоли.
import { chromium } from 'playwright-chromium';
import zlib from 'node:zlib';

const png = (w, h, rgb) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
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
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
let T = null;
function crc32(buf) {
  if (!T) { T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
  let c = 0xffffffff;
  for (const b of buf) c = T[(c ^ b) & 255] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const file = (name, buf) => ({ name, mimeType: 'image/png', buffer: buf });
const MAP = file('map.png', png(600, 400, [60, 55, 45]));
const HERO = file('hero.png', png(64, 64, [130, 160, 95]));

const URL_ = 'http://127.0.0.1:20300/index.html';
const errors = [];

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const dm = await ctxA.newPage();
dm.on('console', (m) => m.type() === 'error' && errors.push('DM console: ' + m.text()));
dm.on('pageerror', (e) => errors.push('DM error: ' + e.message));

await dm.goto(URL_);
await dm.click('[data-gate-tab="create"]');
await dm.fill('#create-form [name=name]', 'Мастер');
await dm.fill('#create-form [name=room]', 'Тестовый стол');
await dm.fill('#create-form [name=key]', 'players');
await dm.fill('#create-form [name=dmkey]', 'master');
await dm.click('#create-form button[type=submit]');
await dm.waitForSelector('#app:not([hidden])');

// локация + карта
dm.once('dialog', (d) => d.accept('Таверна'));
await dm.click('#btn-add-location');
await dm.waitForSelector('#locations-list .list-item');
await dm.setInputFiles('#locations-list .list-item input[type=file]', MAP);
await dm.waitForTimeout(600);

// иконка в библиотеку
await dm.click('[data-ltab="library"]');
await dm.setInputFiles('#lib-upload', HERO);
await dm.waitForSelector('#lib-grid .lib-item');
await dm.dblclick('#lib-grid .lib-item');
await dm.waitForTimeout(400);

// перетаскиваем токен по полю
const box = await dm.locator('#board').boundingBox();
await dm.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await dm.mouse.down();
await dm.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 12 });
await dm.mouse.up();
await dm.waitForTimeout(300);

// туман + кисть
await dm.click('[data-ltab="locations"]');
await dm.check('#fog-on');
await dm.click('[data-tool="fog"]');
await dm.mouse.move(box.x + 400, box.y + 300);
await dm.mouse.down();
await dm.mouse.move(box.x + 520, box.y + 340, { steps: 8 });
await dm.mouse.up();
await dm.click('[data-tool="select"]');

// бой
await dm.click('[data-rtab="init"]');
await dm.click('#init-roll-all');
await dm.waitForSelector('.init-item');
await dm.click('#init-next');

// кубик + чат
await dm.click('#btn-dice');
await dm.click('#dice-buttons .die-btn:nth-child(6)');
await dm.waitForSelector('.die3d');
await dm.click('[data-rtab="chat"]');
await dm.fill('#chat-input', 'Проверка связи');
await dm.press('#chat-input', 'Enter');
await dm.waitForTimeout(300);

// картинка на общий экран
await dm.click('[data-rtab="pics"]');
await dm.setInputFiles('#pics-upload', file('scene.png', png(300, 200, [90, 70, 50])));
await dm.waitForSelector('#pics-grid .lib-item');
await dm.click('#pics-grid .lib-item');
await dm.waitForTimeout(400);
await dm.screenshot({ path: 'tools/shot-dm.png' });

// ── игрок во второй вкладке того же браузера ──
const player = await ctxA.newPage();
player.on('console', (m) => m.type() === 'error' && errors.push('PL console: ' + m.text()));
player.on('pageerror', (e) => errors.push('PL error: ' + e.message));
await player.goto(URL_);
await player.evaluate(() => localStorage.setItem('dnd.me', 'u_player_test'));
await player.reload();
await player.fill('#join-form [name=name]', 'Торин');
await player.fill('#join-form [name=room]', 'Тестовый стол');
await player.fill('#join-form [name=key]', 'players');
await player.click('#join-form button[type=submit]');
await player.waitForSelector('#app:not([hidden])');
await player.waitForTimeout(500);

const playerSees = await player.evaluate(() => ({
  hasDmPanel: !!document.querySelector('#panel-left'),
  showcase: !document.querySelector('#showcase').hidden,
  chat: [...document.querySelectorAll('#chat-feed .msg .body')].map((n) => n.textContent.trim()),
  rolls: document.querySelectorAll('#rolls-feed .msg').length,
}));

// игрок бросает кубик — Мастер должен увидеть анимацию
await player.click('#btn-dice');
await player.click('#dice-buttons .die-btn:nth-child(6)');
await dm.waitForSelector('.die3d', { timeout: 3000 }).catch(() => errors.push('Мастер не увидел бросок игрока'));
await player.screenshot({ path: 'tools/shot-player.png' });

// мобильный вид
const mob = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
const mp = await mob.newPage();
mp.on('pageerror', (e) => errors.push('MOB error: ' + e.message));
await mp.goto(URL_);
await mp.screenshot({ path: 'tools/shot-mobile.png' });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

console.log(JSON.stringify({ playerSees, overflow, errors }, null, 2));
await browser.close();
