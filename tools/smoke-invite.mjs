// Проверка ссылок-приглашений: Мастер открывает свою ссылку и комната создаётся,
// игрок открывает свою и попадает за тот же стол.
import { chromium } from 'playwright-chromium';
import { roomFingerprint } from '../js/sync-firebase.js';
import { FIREBASE } from '../js/firebase-config.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:20300/index.html';
const ROOM = 'Ссылка ' + process.pid;
const KEY = 'pk' + process.pid;
const DMKEY = 'dk' + process.pid;
const q = (o) => new URLSearchParams(o).toString();
const dmLink = `${BASE}?${q({ r: ROOM, k: KEY, m: DMKEY })}`;
const plLink = `${BASE}?${q({ r: ROOM, k: KEY })}`;
const errors = [];
const watch = (p, tag) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(tag + ': ' + m.text()));
  p.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
};

const browser = await chromium.launch();

const dm = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
watch(dm, 'DM');
await dm.goto(dmLink);
const gate = await dm.evaluate(() => ({
  sub: document.querySelector('.gate-sub').innerText,
  roomFieldHidden: document.querySelector('#join-form [name=room]').closest('.field').hidden,
}));
await dm.fill('#join-form [name=name]', 'Мастер');
await dm.click('#join-form button[type=submit]');
await dm.waitForSelector('#app:not([hidden])', { timeout: 20000 });
const dmRole = await dm.textContent('#role-badge');
dm.once('dialog', (d) => d.accept('Подземелье'));
await dm.click('#btn-add-location');
await dm.waitForTimeout(1500);

const pl = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
watch(pl, 'PL');
await pl.goto(plLink);
await pl.fill('#join-form [name=name]', 'Торин');
await pl.click('#join-form button[type=submit]');
await pl.waitForSelector('#app:not([hidden])', { timeout: 20000 });
await pl.waitForTimeout(2500);
const plView = await pl.evaluate(() => ({
  role: document.querySelector('#role-badge').textContent,
  locations: Object.values(window.__state().locations).map((l) => l.name),
}));

// имя запоминается: второй заход по ссылке уже подставляет его
const pl2 = await pl.context().newPage();
await pl2.goto(plLink);
const remembered = await pl2.inputValue('#join-form [name=name]');

console.log(JSON.stringify({ gate, dmRole, plView, remembered, errors }, null, 2));
await browser.close();

const slugRoom = ROOM.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);
const full = slugRoom + '-' + roomFingerprint(slugRoom, KEY);
const res = await fetch(`${FIREBASE.databaseURL}/rooms/${encodeURIComponent(full)}.json`, { method: 'DELETE' });
console.log('очистка:', res.status);
