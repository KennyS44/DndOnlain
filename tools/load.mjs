// Нагрузочная проверка: сколько человек стол выдерживает на самом деле.
// Запуск: node tools/load.mjs 8    (по умолчанию 8 участников вместе с Мастером)
//
// Каждый участник — отдельный браузерный профиль на живом сайте. Мастер ставит
// карту и по фигурке на каждого, дальше все одновременно двигают фигурки,
// пишут в чат и кидают кубики. Меряем задержки, плавность и трафик.

import { chromium } from 'playwright-chromium';
import zlib from 'node:zlib';
import { roomFingerprint } from '../js/sync-firebase.js';
import { FIREBASE } from '../js/firebase-config.js';

const TOTAL = Number(process.argv[2] || 8);        // всего людей за столом, включая Мастера
const SECONDS = Number(process.argv[3] || 45);     // сколько длится «игра»
// Сколько участников — настоящие браузеры. Остальные шлют то же самое напрямую
// в базу без отрисовки: у стенда всего 4 ядра, и лишние браузеры мерили бы его,
// а не сайт. Задержку меряем только в настоящих браузерах.
const BROWSERS = Math.min(TOTAL, Number(process.argv[4] || TOTAL));
const BASE = process.env.BASE_URL || 'https://kennys44.github.io/DndOnlain/';

/* ── картинка карты ── */
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

const ROOM = `Нагрузка ${TOTAL} ${process.pid}`;
const KEY = 'k' + process.pid, DMKEY = 'm' + process.pid;
const q = (o) => new URLSearchParams(o).toString();
const NAMES = ['Торин', 'Двалин', 'Балин', 'Кили', 'Фили', 'Оин', 'Глоин', 'Бифур', 'Бофур', 'Бомбур',
  'Дори', 'Нори', 'Ори', 'Бильбо', 'Гэндальф', 'Радагаст', 'Леголас', 'Гимли', 'Арагорн'];
const errors = [];
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
};

const browser = await chromium.launch();
const openPage = async (name, link) => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  const t = Date.now();
  await page.goto(link);
  await page.fill('#join-form [name=name]', name);
  await page.click('#join-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 60000 });
  return { page, name, joinMs: Date.now() - t };
};

console.log(`⏱  ${TOTAL} человек, ${SECONDS} секунд игры, сайт: ${BASE}`);

/* ── Мастер готовит стол ── */
const dm = await openPage('Мастер', `${BASE}?${q({ r: ROOM, k: KEY, m: DMKEY })}`);
dm.page.once('dialog', (d) => d.accept('Поле боя'));
await dm.page.click('#btn-add-location');
await dm.page.waitForSelector('#locations-list .list-item');
await dm.page.setInputFiles('#locations-list .list-item input[type=file]',
  { name: 'map.png', mimeType: 'image/png', buffer: png(1200, 900, [58, 54, 44]) });
await dm.page.waitForTimeout(2000);

const players = NAMES.slice(0, TOTAL - 1);
const ghostNames = players.slice(BROWSERS - 1);          // им браузер не достался
const browserNames = players.slice(0, BROWSERS - 1);
await dm.page.evaluate((names) => {
  const s = window.__state();
  names.forEach((n, i) => {
    window.__dispatch({
      t: 'token.add',
      token: {
        id: 'tok' + i, locId: s.activeLoc, x: 100 + (i % 5) * 140, y: 100 + Math.floor(i / 5) * 140,
        cells: 1, assetId: null, name: n, kind: 'pc', ownerName: n, ownerId: null,
        hp: { cur: 20, max: 20 }, statuses: [], vision: 30,
      },
    });
  });
}, players);
await dm.page.waitForTimeout(1500);

/* ── игроки заходят все разом ── */
const joinStart = Date.now();
const joined = await Promise.all(browserNames.map((n) => openPage(n, `${BASE}?${q({ r: ROOM, k: KEY })}`)));
const allJoinedMs = Date.now() - joinStart;
const table = [dm, ...joined];

/* ── участники без браузера: те же действия, только напрямую в базу ── */
const slugRoom = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
const roomRef = `${FIREBASE.databaseURL}/rooms/${encodeURIComponent(slugRoom + '-' + roomFingerprint(slugRoom, KEY))}`;
const post = (node, body) => fetch(`${roomRef}/${node}.json`, { method: 'POST', body: JSON.stringify(body) })
  .catch((e) => errors.push('призрак: ' + e.message));

async function ghost(name, i) {
  const id = 'ghost' + i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await fetch(`${roomRef}/presence/${id}.json`, {
    method: 'PUT', body: JSON.stringify({ id, name, role: 'player', at: Date.now() }),
  });
  const tokenId = 'tok' + (BROWSERS - 1 + i);
  const until = Date.now() + SECONDS * 1000;
  let step = 0;
  await sleep(i * 120);
  while (Date.now() < until) {
    for (let k = 1; k <= 4; k++) {
      await post('actions', {
        from: id, ts: Date.now(),
        a: { t: 'token.update', id: tokenId, patch: { x: 200 + k * 18 * (step % 2 ? 1 : -1), y: 200, mt: Date.now() } },
      });
      await sleep(80);
    }
    if (step % 3 === 1) {
      await post('actions', {
        from: id, ts: Date.now(),
        a: { t: 'chat.add', msg: { id: id + step, ts: Date.now(), by: id, name, kind: 'chat', text: `${name}: ход ${step}` } },
      });
    }
    step++;
    await sleep(1800 + Math.random() * 900);
  }
}

/* ── наблюдатели: замеряем, когда чужое действие доехало ── */
await Promise.all(table.map(({ page }) => page.evaluate(() => {
  // всё, что уже лежит в комнате на момент старта замера, латентностью не считаем
  window.__lat = { move: [], chat: [], seenChat: new Set(window.__state().chat.map((m) => m.id)), lastMt: {} };
  window.__frames = [];
  let prev = performance.now();
  const tick = (t) => { window.__frames.push(t - prev); prev = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => {
    const s = window.__state();
    const now = Date.now();
    Object.values(s.tokens).forEach((t) => {
      if (t.mt && window.__lat.lastMt[t.id] !== t.mt) {
        window.__lat.lastMt[t.id] = t.mt;
        if (t.ownerName !== window.__me().name) window.__lat.move.push(now - t.mt);
      }
    });
    s.chat.forEach((m) => {
      if (window.__lat.seenChat.has(m.id)) return;
      window.__lat.seenChat.add(m.id);
      if (m.by !== window.__me().id && m.ts) window.__lat.chat.push(now - m.ts);
    });
  }, 50);
})));

/* ── игра: все шевелятся одновременно ── */
const ghosts = ghostNames.map((n, i) => ghost(n, i));
await Promise.all([...ghosts, ...table.map(({ page, name }, idx) => page.evaluate(async ({ name, idx, seconds }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const myToken = () => Object.values(window.__state().tokens).find((t) => t.ownerName === name);
  const until = Date.now() + seconds * 1000;
  await sleep(idx * 120);
  let step = 0;
  while (Date.now() < until) {
    const t = myToken();
    if (t) {
      // «перетаскивание»: несколько частых обновлений, как при движении мышью
      const dir = step % 2 ? 1 : -1;
      for (let k = 1; k <= 4; k++) {
        window.__dispatch({
          t: 'token.update', id: t.id,
          patch: { x: t.x + dir * k * 18, y: t.y + dir * k * 6, mt: Date.now() },
        });
        await sleep(80);
      }
    }
    if (step % 3 === 1) {
      document.querySelector('#chat-input').value = `${name}: ход ${step}`;
      document.querySelector('#chat-form').dispatchEvent(new Event('submit', { cancelable: true }));
    }
    if (step % 4 === 2) {
      document.querySelector('#btn-dice').click();
      document.querySelectorAll('#dice-buttons .die-btn')[5].click();
    }
    step++;
    await sleep(1800 + Math.random() * 900);
  }
}, { name, idx, seconds: SECONDS }))]);

/* ── итоги ── */
const perClient = await Promise.all(table.map(async ({ page, name, joinMs }) => {
  const r = await page.evaluate(() => ({
    move: window.__lat.move, chat: window.__lat.chat,
    frames: window.__frames.slice(-600),
    stats: window.__stats(),
    chatLen: window.__state().chat.length,
  }));
  return { name, joinMs, ...r };
}));

const allMove = perClient.flatMap((c) => c.move);
const allChat = perClient.flatMap((c) => c.chat);
const allFrames = perClient.flatMap((c) => c.frames);
const sent = perClient.reduce((a, c) => a + (c.stats?.bytesSent || 0), 0);
const got = perClient.reduce((a, c) => a + (c.stats?.bytesGot || 0), 0);
const stateWrites = perClient.reduce((a, c) => a + (c.stats?.stateWrites || 0), 0);

const path = encodeURIComponent(slugRoom + '-' + roomFingerprint(slugRoom, KEY));
const stateBytes = await fetch(`${FIREBASE.databaseURL}/rooms/${path}/state.json`)
  .then((r) => r.text()).then((t) => t.length).catch(() => null);
const actionsLeft = await fetch(`${FIREBASE.databaseURL}/rooms/${path}/actions.json?shallow=true`)
  .then((r) => r.json()).then((o) => Object.keys(o || {}).length).catch(() => null);

console.log(JSON.stringify({
  человек: TOTAL,
  изНихБраузеров: BROWSERS,
  вход: { всеЗашлиЗаМс: allJoinedMs, самыйДолгийМс: Math.max(...table.map((t) => t.joinMs)) },
  перемещениеМс: { медиана: pct(allMove, .5), p95: pct(allMove, .95), максимум: pct(allMove, 1), замеров: allMove.length },
  чатМс: { медиана: pct(allChat, .5), p95: pct(allChat, .95), максимум: pct(allChat, 1), замеров: allChat.length },
  кадрыМс: { медиана: pct(allFrames, .5), p95: pct(allFrames, .95), худший: pct(allFrames, 1) },
  трафик: {
    отправленоВсемиКб: Math.round(sent / 1024),
    полученоВсемиКб: Math.round(got / 1024),
    записейСостояния: stateWrites,
    размерСостоянияКб: stateBytes ? Math.round(stateBytes / 1024) : null,
    действийОсталосьВБазе: actionsLeft,
    вМесяцНаТакихСессийГб: stateBytes ? +(got / 1024 / 1024 / 1024 * (30 * 4 * (240 / SECONDS))).toFixed(2) : null,
  },
  ошибки: errors.slice(0, 10),
  ошибокВсего: errors.length,
}, null, 2));

await browser.close();
await fetch(`${FIREBASE.databaseURL}/rooms/${path}.json`, { method: 'DELETE' });
