// Диагностика жалоб: динамика обновлений, видимость участников,
// анимация броска у всех, перемещение токена у всех.
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
    raw[o] = rgb[0]; raw[o + 1] = rgb[1] ^ (x & 15); raw[o + 2] = rgb[2];
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
const ROOM = 'Диаг ' + process.pid;
const KEY = 'pk' + process.pid, DMKEY = 'dk' + process.pid;
const q = (o) => new URLSearchParams(o).toString();
const report = {};
const errors = [];
const watch = (p, t) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(t + ': ' + m.text()));
  p.on('pageerror', (e) => errors.push(t + ': ' + e.message));
};
const since = () => Date.now();

const browser = await chromium.launch();
const dm = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage(); watch(dm, 'DM');
await dm.goto(`${BASE}?${q({ r: ROOM, k: KEY, m: DMKEY })}`);
await dm.fill('#join-form [name=name]', 'Мастер');
await dm.click('#join-form button[type=submit]');
await dm.waitForSelector('#app:not([hidden])', { timeout: 20000 });

dm.once('dialog', (d) => d.accept('Зал'));
await dm.click('#btn-add-location');
await dm.click('[data-ltab="library"]');
await dm.setInputFiles('#lib-upload', img('pc.png', png(64, 64, [120, 160, 90])));
await dm.waitForSelector('#lib-grid .lib-item');
await dm.dblclick('#lib-grid .lib-item');
await dm.waitForTimeout(1200);

// игрок заходит позже
const pl = await (await browser.newContext({ viewport: { width: 1300, height: 850 } })).newPage(); watch(pl, 'PL');
await pl.goto(`${BASE}?${q({ r: ROOM, k: KEY })}`);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(3000);

// 1. видит ли Мастер игрока (ростер + присутствие)
report.dmSeesPlayer = await dm.evaluate(() => ({
  roster: Object.values(window.__state().roster).map((m) => m.name),
  dots: document.querySelectorAll('#members .dot').length,
  membersList: [...document.querySelectorAll('#members-list .name')].map((n) => n.textContent),
}));

// 2. список в карточке токена (кому принадлежит)
const tokenAt = (page) => page.evaluate(() => {
  const t = Object.values(window.__state().tokens)[0];
  return window.__board().worldToScreen(t.x, t.y);
});
const dmBox = await dm.locator('#board').boundingBox();
const tpos = await tokenAt(dm);
await dm.mouse.dblclick(dmBox.x + tpos.x, dmBox.y + tpos.y);
await dm.waitForTimeout(400);
report.ownerOptions = await dm.evaluate(() => {
  const sel = document.querySelector('#token-card select');
  return sel ? [...sel.options].map((o) => o.text) : 'карточка не открылась';
});

// 3. бросок игрока → видит ли Мастер анимацию
await pl.click('#btn-dice');
const t0 = since();
await pl.click('#dice-buttons .die-btn:nth-child(6)');
report.dmSeesPlayerRollMs = await dm.waitForSelector('.die', { timeout: 15000 })
  .then(() => since() - t0).catch(() => 'НЕ УВИДЕЛ');
await dm.waitForTimeout(6500);

// 4. бросок Мастера → видит ли игрок
await dm.click('#btn-dice');
const t1 = since();
await dm.click('#dice-buttons .die-btn:nth-child(6)');
report.plSeesDmRollMs = await pl.waitForSelector('.die', { timeout: 15000 })
  .then(() => since() - t1).catch(() => 'НЕ УВИДЕЛ');
await dm.waitForTimeout(6500);

// 5. перемещение токена Мастером → видит ли игрок, и за сколько
await dm.keyboard.press('Escape').catch(() => {});
await dm.mouse.click(dmBox.x + 40, dmBox.y + 40);   // закрыть карточку токена
const x0 = await pl.evaluate(() => Object.values(window.__state().tokens)[0].x);
const box = dmBox;
const grab = await tokenAt(dm);
const t2 = since();
await dm.mouse.move(box.x + grab.x, box.y + grab.y);
await dm.mouse.down();
await dm.mouse.move(box.x + grab.x + 200, box.y + grab.y + 80, { steps: 20 });
await dm.mouse.up();
report.plSeesMoveMs = await pl.waitForFunction((a) => Object.values(window.__state().tokens)[0].x !== a, x0, { timeout: 15000 })
  .then(() => since() - t2).catch(() => 'НЕ УВИДЕЛ');

// 6. сколько действий улетело в базу за одно перетаскивание
report.actionsAfterDrag = await fetch(`${FIREBASE.databaseURL}/rooms/${roomPath()}/actions.json?shallow=true`)
  .then((r) => r.json()).then((o) => Object.keys(o || {}).length).catch((e) => 'н/д: ' + e.message);

// 7. чат игрока → Мастер
const t3 = since();
await pl.fill('#chat-input', 'привет');
await pl.press('#chat-input', 'Enter');
report.dmSeesChatMs = await dm.waitForFunction(() => [...document.querySelectorAll('#chat-feed .body')].some((n) => n.textContent.includes('привет')), null, { timeout: 15000 })
  .then(() => since() - t3).catch(() => 'НЕ УВИДЕЛ');

// 8. игрок двигает СВОЙ токен (Мастер назначил владельца) → видит ли Мастер
report.ownerAssigned = await dm.evaluate(() => {
  const s = window.__state();
  const tok = Object.values(s.tokens)[0];
  const player = Object.values(s.roster).find((m) => m.role !== 'dm');
  if (player) window.__dispatch({ t: 'token.update', id: tok.id, patch: { ownerName: player.name, ownerId: player.id } });
  return player ? player.name : 'игрока в ростере нет';
});
await pl.waitForTimeout(2000);
const y0 = await dm.evaluate(() => Object.values(window.__state().tokens)[0].x);
await pl.click('#dice-close');          // убрать панель кубиков с дороги
await pl.click('#zoom-fit');            // вернуть камеру, чтобы фигурка была в кадре
await pl.waitForTimeout(300);
const pbox = await pl.locator('#board').boundingBox();
const tp = await pl.evaluate(() => {
  const s = window.__state(); const t = Object.values(s.tokens)[0];
  return window.__board().worldToScreen(t.x, t.y);
});
report.playerGrab = { tp, canvas: { w: Math.round(pbox.width), h: Math.round(pbox.height) } };
const t4 = since();
await pl.mouse.move(pbox.x + tp.x, pbox.y + tp.y);
await pl.mouse.down();
await pl.mouse.move(pbox.x + tp.x - 220, pbox.y + tp.y + 40, { steps: 15 });
await pl.mouse.up();
report.dmSeesPlayerMoveMs = await dm.waitForFunction((a) => Object.values(window.__state().tokens)[0].x !== a, y0, { timeout: 15000 })
  .then(() => since() - t4).catch(() => 'НЕ УВИДЕЛ');
report.moveDebug = {
  xБылоУМастера: Math.round(y0),
  xСталоУИгрока: await pl.evaluate(() => Math.round(Object.values(window.__state().tokens)[0].x)),
  xСталоУМастера: await dm.evaluate(() => Math.round(Object.values(window.__state().tokens)[0].x)),
  правоДвигать: await pl.evaluate(() => {
    const t = Object.values(window.__state().tokens)[0];
    return { ownerName: t.ownerName, я: window.__state().roster ? undefined : undefined, имя: window.__me ? window.__me().name : '?' };
  }),
};

// 9. САМОЕ ГЛАВНОЕ: Мастер и игрок в одном браузере (вторая вкладка того же профиля)
const tab2 = await dm.context().newPage(); watch(tab2, 'TAB2');
await tab2.goto(`${BASE}?${q({ r: ROOM, k: KEY })}`);
await tab2.fill('#join-form [name=name]', 'Двалин');
await tab2.click('#join-form button[type=submit]');
await tab2.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await tab2.waitForTimeout(3000);

report.sameBrowser = {
  dmSeesBoth: await dm.evaluate(() => [...document.querySelectorAll('#members-list .name')].map((n) => n.textContent)),
  chatMs: await (async () => {
    const t = since();
    await tab2.fill('#chat-input', 'из второй вкладки');
    await tab2.press('#chat-input', 'Enter');
    return dm.waitForFunction(() => [...document.querySelectorAll('#chat-feed .body')].some((n) => n.textContent.includes('из второй вкладки')), null, { timeout: 15000 })
      .then(() => since() - t).catch(() => 'НЕ ДОШЛО');
  })(),
  rollMs: await (async () => {
    const t = since();
    await tab2.click('#btn-dice');
    await tab2.click('#dice-buttons .die-btn:nth-child(6)');
    return dm.waitForSelector('.die', { timeout: 15000 }).then(() => since() - t).catch(() => 'НЕ УВИДЕЛ');
  })(),
};
await dm.waitForTimeout(1600);
await dm.screenshot({ path: 'tools/shot-dice.png' });

report.errors = errors;
console.log(JSON.stringify(report, null, 2));
await dm.screenshot({ path: 'tools/shot-diag.png' });
await browser.close();

function roomPath() {
  const s = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
  return encodeURIComponent(s + '-' + roomFingerprint(s, KEY));
}
await fetch(`${FIREBASE.databaseURL}/rooms/${roomPath()}.json`, { method: 'DELETE' });
