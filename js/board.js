// Поле боя: карта, сетка, токены, туман войны, рисование, линейка.
// Всё рисуется в один canvas — так проще держать зум и перетаскивание согласованными.

const IMG_CACHE = new Map();

export function createBoard(opts) {
  const { canvas, store, sync, me, isDM, onTokenOpen, onViewChange } = opts;
  const ctx = canvas.getContext('2d');

  let view = { x: 0, y: 0, scale: 1 };
  let tool = 'select';
  let draw = { shape: 'pen', color: '#c9a45a', width: 4 };
  let fogBrush = 1;
  let fogMode = 'reveal';       // 'reveal' — открывает местность, 'hide' — возвращает туман
  let wallKind = 'wall';        // что чертим: 'wall' — стена, 'door' — дверь
  let eraseSize = 40;           // радиус ластика в пикселях карты — заметно крупнее кисти
  let eraseWork = null;         // что останется от рисунков, пока ластик ведут
  let hoverAt = null;           // где курсор: для круга ластика
  const visionCache = new Map();

  // временные состояния взаимодействия
  let drag = null;         // {type:'pan'|'token'|'ruler'|'draw'|'fog', ...}
  const pointers = new Map();
  let pinch = null;
  let ruler = null;        // {a:{x,y}, b:{x,y}}
  let preview = null;      // текущий незавершённый штрих
  let fogBatch = null;     // {cells:Set, on:bool}
  let hoverId = null;
  let touched = false;      // камеру уже двигали руками — не вписываем автоматически
  let lastLocId = null;

  const fogLayer = document.createElement('canvas');

  /* ── помощники ─────────────────────────────────────────────── */
  const S = () => store.get();
  const loc = () => { const s = S(); return s.activeLoc ? s.locations[s.activeLoc] : null; };
  const toksHere = () => { const l = loc(); return l ? Object.values(S().tokens).filter((t) => t.locId === l.id) : []; };

  const w2s = (x, y) => ({ x: x * view.scale + view.x, y: y * view.scale + view.y });
  const s2w = (x, y) => ({ x: (x - view.x) / view.scale, y: (y - view.y) / view.scale });

  function evPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function getImage(assetId) {
    if (!assetId) return null;
    if (IMG_CACHE.has(assetId)) return IMG_CACHE.get(assetId);
    IMG_CACHE.set(assetId, null);
    sync.getAsset(assetId).then((url) => {
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        IMG_CACHE.set(assetId, img);
        // карта догрузилась позже входа — вписываем её, если камеру ещё не трогали
        const l = loc();
        if (l && l.assetId === assetId && !touched) api.fit(); else render();
      };
      img.src = url;
    });
    return null;
  }

  const nameKey = (n) => String(n || '').trim().toLowerCase();
  function canMove(t) {
    return isDM || t.ownerId === me.id || (t.ownerName && nameKey(t.ownerName) === nameKey(me.name));
  }

  /* ── сетка и клетки ────────────────────────────────────────── */
  function gridOf() { const l = loc(); return l ? l.grid : { size: 70, ox: 0, oy: 0, feet: 5, show: true }; }
  function cellKey(wx, wy) {
    const g = gridOf();
    return Math.floor((wx - g.ox) / g.size) + ',' + Math.floor((wy - g.oy) / g.size);
  }
  function cellCenter(wx, wy) {
    const g = gridOf();
    const cx = Math.floor((wx - g.ox) / g.size), cy = Math.floor((wy - g.oy) / g.size);
    return { x: g.ox + (cx + 0.5) * g.size, y: g.oy + (cy + 0.5) * g.size };
  }
  const feetPerPx = () => { const g = gridOf(); return g.feet / g.size; };

  /* ── отрисовка ─────────────────────────────────────────────── */
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fogLayer.width = canvas.width; fogLayer.height = canvas.height;
    render();
  }

  function render() {
    const r = canvas.getBoundingClientRect();
    const W = r.width, H = r.height;
    ctx.clearRect(0, 0, W, H);
    const l = loc();
    if (!l) return;
    if (l.id !== lastLocId) {          // сменили локацию — показываем её целиком
      lastLocId = l.id; touched = false;
      api.fit(); return;
    }

    // карта
    const map = getImage(l.assetId);
    if (map) {
      ctx.imageSmoothingQuality = 'high';
      const p = w2s(0, 0);
      ctx.drawImage(map, p.x, p.y, map.width * view.scale, map.height * view.scale);
    }

    const bounds = mapBounds();
    if (l.grid.show) drawGrid(W, H, bounds);
    drawStrokes(eraseWork || l.drawings || []);   // под ластиком показываем, что останется
    if (preview) drawStroke(preview, true);
    drawTokens();
    if (l.fogOn) drawFog(W, H, bounds);
    drawWalls();
    if (ruler) drawRuler();
    if (drag && drag.type === 'fog') drawBrushCursor();
    if (tool === 'draw' && draw.shape === 'eraser' && hoverAt) {
      const r = eraseSize * view.scale;
      ctx.save();
      const g = ctx.createRadialGradient(hoverAt.x, hoverAt.y, r * .35, hoverAt.x, hoverAt.y, r);
      g.addColorStop(0, 'rgba(236,230,217,0)');
      g.addColorStop(1, 'rgba(236,230,217,.16)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(hoverAt.x, hoverAt.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(236,230,217,.9)';
      ctx.stroke();
      ctx.setLineDash([]); ctx.strokeStyle = 'rgba(23,22,19,.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(hoverAt.x, hoverAt.y, r + 1.5, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (drag && drag.type === 'wall-new') {
      const a = w2s(drag.a.x, drag.a.y), b = w2s(drag.b.x, drag.b.y);
      ctx.save(); ctx.globalAlpha = .75;
      if (wallKind === 'door') drawDoor(a, b, false); else drawStoneWall(a, b, 7);
      ctx.restore();
    }
  }

  function mapBounds() {
    const l = loc();
    const map = l && getImage(l.assetId);
    if (map) return { x: 0, y: 0, w: map.width, h: map.height };
    const r = canvas.getBoundingClientRect();
    const a = s2w(0, 0), b = s2w(r.width, r.height);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  function drawGrid(W, H, b) {
    const g = gridOf();
    const step = g.size * view.scale;
    if (step < 6) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(236,230,217,.16)';
    ctx.lineWidth = 1;
    const x0 = w2s(b.x, b.y).x, y0 = w2s(b.x, b.y).y;
    const startX = x0 + ((g.ox * view.scale) % step + step) % step - step;
    const startY = y0 + ((g.oy * view.scale) % step + step) % step - step;
    const right = Math.min(W, w2s(b.x + b.w, 0).x), bottom = Math.min(H, w2s(0, b.y + b.h).y);
    ctx.beginPath();
    for (let x = startX; x <= right; x += step) { ctx.moveTo(Math.round(x) + .5, Math.max(0, y0)); ctx.lineTo(Math.round(x) + .5, bottom); }
    for (let y = startY; y <= bottom; y += step) { ctx.moveTo(Math.max(0, x0), Math.round(y) + .5); ctx.lineTo(right, Math.round(y) + .5); }
    ctx.stroke();
    ctx.restore();
  }

  function drawTokens() {
    const g = gridOf();
    toksHere().forEach((t) => {
      const size = g.size * t.cells * view.scale;
      const p = w2s(t.x, t.y);
      const img = getImage(t.assetId);
      ctx.save();
      // подставка
      ctx.beginPath();
      ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#1e1c18';
      ctx.fill();
      if (img) {
        ctx.save(); ctx.clip();
        ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
        ctx.restore();
      } else {
        ctx.fillStyle = '#3a352c'; ctx.fill();
        ctx.fillStyle = '#ece6d9'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `${Math.max(10, size * .4)}px Cinzel, serif`;
        ctx.fillText((t.name || '?').slice(0, 1).toUpperCase(), p.x, p.y);
      }
      ctx.lineWidth = Math.max(2, size * .04);
      ctx.strokeStyle = ringColor(t);
      ctx.beginPath(); ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2); ctx.stroke();

      // подпись и здоровье
      if (size > 34) {
        ctx.font = '12px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const label = t.name || '';
        const ty = p.y + size / 2 + 4;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(23,22,19,.7)';
        ctx.fillRect(p.x - tw / 2 - 4, ty - 2, tw + 8, 16);
        ctx.fillStyle = '#ece6d9';
        ctx.fillText(label, p.x, ty);

        if (t.hp && t.hp.max > 0 && (isDM || t.hpPublic !== false)) {
          const bw = size * .8, bh = 5;
          const bx = p.x - bw / 2, by = p.y - size / 2 - 10;
          ctx.fillStyle = 'rgba(58,47,42,.9)'; ctx.fillRect(bx, by, bw, bh);
          const k = Math.max(0, Math.min(1, t.hp.cur / t.hp.max));
          ctx.fillStyle = k > .5 ? '#83a05f' : k > .25 ? '#c9a45a' : '#b8604a';
          ctx.fillRect(bx, by, bw * k, bh);
          // Мастеру видно всегда: пунктир значит «игроки этой полоски не видят»
          if (t.hpPublic === false) {
            ctx.save();
            ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(236,230,217,.75)';
            ctx.strokeRect(bx - 1.5, by - 1.5, bw + 3, bh + 3);
            ctx.restore();
          }
        }
        if (t.statuses && t.statuses.length) {
          ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = '#c9a45a'; ctx.textBaseline = 'bottom';
          ctx.fillText(t.statuses.map((x) => x.slice(0, 3)).join('·'), p.x, p.y - size / 2 - 12);
        }
      }
      ctx.restore();
    });
  }

  function ringColor(t) {
    if (hoverId === t.id) return '#e0c063';
    if (t.ownerName || t.ownerId) return '#7fa8c9';
    return t.kind === 'enemy' ? '#b8604a' : t.kind === 'pc' ? '#83a05f' : '#8d7440';
  }

  function drawStrokes(list) { list.forEach((d) => drawStroke(d, false)); }

  /* ── Ластик: стирает куски линий, а фигуры — целиком ─────────── */

  const fragId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /** Задел ли ластик фигуру (для тех, что нельзя разрезать пополам). */
  function shapeTouched(d, w, r) {
    if (d.pts.length < 2) return false;
    const [a, b] = d.pts;
    if (distToSeg(w, { x1: a.x, y1: a.y, x2: b.x, y2: b.y }) <= r) return true;
    if (d.shape === 'circle' || d.shape === 'cone') {
      const rad = Math.hypot(b.x - a.x, b.y - a.y);
      const dist = Math.hypot(w.x - a.x, w.y - a.y);
      if (Math.abs(dist - rad) <= r) return true;         // задели дугу
    }
    if (d.shape === 'rect') {
      const edges = [
        { x1: a.x, y1: a.y, x2: b.x, y2: a.y }, { x1: b.x, y1: a.y, x2: b.x, y2: b.y },
        { x1: b.x, y1: b.y, x2: a.x, y2: b.y }, { x1: a.x, y1: b.y, x2: a.x, y2: a.y },
      ];
      if (edges.some((e) => distToSeg(w, e) <= r)) return true;
    }
    return false;
  }

  /** Проводим ластиком: линии рвутся на куски, куски короче двух точек пропадают. */
  function eraseStep(w) {
    const r = eraseSize;
    const next = [];
    eraseWork.forEach((d) => {
      if (d.shape === 'pen' || d.shape === 'marker') {
        let run = [];
        const parts = [];
        d.pts.forEach((p) => {
          if (Math.hypot(p.x - w.x, p.y - w.y) <= r) {
            if (run.length >= 2) parts.push(run);
            run = [];
          } else run.push(p);
        });
        if (run.length >= 2) parts.push(run);
        if (parts.length === 1 && parts[0].length === d.pts.length) next.push(d);   // не задели
        else parts.forEach((pts) => next.push({ ...d, id: fragId(), pts }));
      } else if (!shapeTouched(d, w, r)) {
        next.push(d);
      }
    });
    eraseWork = next;
  }

  function drawStroke(d, isPreview) {
    ctx.save();
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = Math.max(1, d.width * view.scale);
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.globalAlpha = d.shape === 'marker' ? .3 : isPreview ? .8 : 1;
    if (d.shape === 'marker') ctx.lineWidth *= 3;
    const p = d.pts.map((q) => w2s(q.x, q.y));
    if (!p.length) { ctx.restore(); return; }

    if (d.shape === 'pen' || d.shape === 'marker') {
      ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
      p.slice(1).forEach((q) => ctx.lineTo(q.x, q.y));
      ctx.stroke();
    } else if (p.length >= 2) {
      const a = p[0], b = p[p.length - 1];
      if (d.shape === 'line' || d.shape === 'arrow') {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        if (d.shape === 'arrow') {
          const ang = Math.atan2(b.y - a.y, b.x - a.x), h = 12 + ctx.lineWidth;
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(b.x - h * Math.cos(ang - .4), b.y - h * Math.sin(ang - .4));
          ctx.lineTo(b.x - h * Math.cos(ang + .4), b.y - h * Math.sin(ang + .4));
          ctx.closePath(); ctx.fill();
        }
      } else if (d.shape === 'rect') {
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      } else if (d.shape === 'circle') {
        const rr = Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath(); ctx.arc(a.x, a.y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = .12; ctx.fill();
        labelFeet(rr, a.x, a.y - rr - 16);          // над краем круга, а не в центре
      } else if (d.shape === 'cone') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x), rr = Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        ctx.arc(a.x, a.y, rr, ang - .45, ang + .45); ctx.closePath();
        ctx.stroke(); ctx.globalAlpha = .14; ctx.fill();
        // подпись за дальним краем конуса, по направлению броска
        labelFeet(rr, a.x + Math.cos(ang) * (rr + 20), a.y + Math.sin(ang) * (rr + 20));
      }
    }
    ctx.restore();
  }

  /** Подпись дальности ставим у края фигуры, чтобы она не легла на иконку существа. */
  function labelFeet(rPx, x, y) {
    const ft = Math.round((rPx / view.scale) * feetPerPx());
    const r = canvas.getBoundingClientRect();
    chip(ft + ' фт', Math.max(40, Math.min(r.width - 40, x)), Math.max(20, Math.min(r.height - 20, y)));
  }

  /** Настоящее расстояние по прямой: диагональ длиннее стороны клетки. */
  function rulerReadout() {
    const g = gridOf();
    const cells = Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y) / g.size;
    return { cells, feet: Math.round(cells * g.feet) };
  }

  function drawRuler() {
    const a = w2s(ruler.a.x, ruler.a.y), b = w2s(ruler.b.x, ruler.b.y);
    const { cells, feet } = rulerReadout();
    ctx.save();
    ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = '#c9a45a';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    [a, b].forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#c9a45a'; ctx.fill(); });
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    chip(`${feet} фт · ${cells.toFixed(1)} кл`, mx, my);
    ctx.restore();
  }

  /** Подпись на плашке-табличке: тёмная кость с золотым кантом, читается везде. */
  function chip(text, x, y) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width;
    const bx = x - w / 2 - 10, by = y - 13, bw = w + 20, bh = 26;
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    g.addColorStop(0, 'rgba(46,42,34,.96)');
    g.addColorStop(1, 'rgba(23,22,19,.96)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(201,164,90,.75)'; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.beginPath(); ctx.roundRect(bx + 1.5, by + 1.5, bw - 3, bh - 3, 6); ctx.stroke();
    ctx.fillStyle = '#f0e7d5';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawBrushCursor() {
    const g = gridOf();
    const p = drag.last;
    if (!p) return;
    const w = s2w(p.x, p.y);
    const n = Math.max(1, fogBrush), half = Math.floor((n - 1) / 2);
    const cx = Math.floor((w.x - g.ox) / g.size) - half;
    const cy = Math.floor((w.y - g.oy) / g.size) - half;
    const a = w2s(g.ox + cx * g.size, g.oy + cy * g.size);
    const side = n * g.size * view.scale;
    const tone = drag.on ? '#83a05f' : '#b8604a';
    ctx.save();
    ctx.fillStyle = drag.on ? 'rgba(131,160,95,.14)' : 'rgba(184,96,74,.16)';
    ctx.fillRect(a.x, a.y, side, side);
    ctx.strokeStyle = tone; ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, side, side);
    ctx.lineWidth = 3;                                  // уголки-засечки
    const c = Math.min(10, side * .28);
    [[0, 0, 1, 1], [side, 0, -1, 1], [0, side, 1, -1], [side, side, -1, -1]].forEach(([ox, oy, sx, sy]) => {
      ctx.beginPath();
      ctx.moveTo(a.x + ox, a.y + oy + sy * c); ctx.lineTo(a.x + ox, a.y + oy);
      ctx.lineTo(a.x + ox + sx * c, a.y + oy);
      ctx.stroke();
    });
    ctx.restore();
  }

  /* ── Стены и двери: обзор обрывается о них ──────────────────── */

  const wallsOf = () => { const l = loc(); return (l && l.walls) || []; };
  /** Что перекрывает обзор: стены всегда, двери — пока закрыты. */
  const blockers = () => wallsOf().filter((w) => w.type !== 'door' || !w.open);

  /** Насколько далеко луч из точки уходит до отрезка (null — не пересекает). */
  function rayHit(px, py, dx, dy, s) {
    const sx = s.x2 - s.x1, sy = s.y2 - s.y1;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((s.x1 - px) * sy - (s.y1 - py) * sx) / den;
    const u = ((s.x1 - px) * dy - (s.y1 - py) * dx) / den;
    return (t >= 0 && u >= 0 && u <= 1) ? t : null;
  }

  /** Многоугольник видимости вокруг существа с учётом стен. */
  function visionShape(t, radius) {
    const segs = blockers();
    const sig = `${Math.round(t.x)},${Math.round(t.y)},${Math.round(radius)},${segs.length},`
      + segs.map((s) => `${s.id}:${Math.round(s.x1)},${Math.round(s.y1)},${Math.round(s.x2)},${Math.round(s.y2)},${s.open ? 1 : 0}`).join('|');
    const hit = visionCache.get(t.id);
    if (hit && hit.sig === sig) return hit.pts;

    const N = 180;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      let best = radius;
      for (const s of segs) {
        const d = rayHit(t.x, t.y, dx, dy, s);
        if (d !== null && d < best) best = d;
      }
      pts.push({ x: t.x + dx * best, y: t.y + dy * best });
    }
    visionCache.set(t.id, { sig, pts });
    return pts;
  }

  /** Один и тот же «случайный» скол у камня при каждой отрисовке. */
  function jitter(seed, i) {
    const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    return v - Math.floor(v) - 0.5;
  }

  /** Кладка: блоки со швами, светлая верхняя грань, тёмная нижняя. */
  function drawStoneWall(a, b, seed) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) return;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const th = Math.max(5, 9 * view.scale);           // толщина кладки
    const block = Math.max(14, 26 * view.scale);
    ctx.save();
    ctx.translate(a.x, a.y); ctx.rotate(ang);

    ctx.fillStyle = '#2f3138';                        // раствор между камнями
    ctx.fillRect(0, -th / 2 - 1, len, th + 2);

    const n = Math.max(1, Math.round(len / block));
    for (let i = 0; i < n; i++) {
      const x0 = (len / n) * i + 1;
      const w = (len / n) - 2;
      const up = jitter(seed, i) * th * 0.18;
      const g = ctx.createLinearGradient(0, -th / 2, 0, th / 2);
      const tone = 108 + Math.round(jitter(seed, i + 99) * 26);
      g.addColorStop(0, `rgb(${tone + 26},${tone + 30},${tone + 38})`);
      g.addColorStop(.55, `rgb(${tone - 6},${tone - 2},${tone + 6})`);
      g.addColorStop(1, `rgb(${tone - 34},${tone - 32},${tone - 24})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x0, -th / 2 + up, w, th - Math.abs(up), Math.min(3, th * .25));
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(20,19,16,.75)'; ctx.lineWidth = 1;
    ctx.strokeRect(0, -th / 2, len, th);
    ctx.restore();
  }

  /** Дверь: доски, железные полосы, кольцо-ручка. Открытая — отведена в сторону. */
  function drawDoor(a, b, open) {
    const full = Math.hypot(b.x - a.x, b.y - a.y);
    if (full < 1) return;
    const ang0 = Math.atan2(b.y - a.y, b.x - a.x);
    const ang = open ? ang0 - Math.PI / 3 : ang0;     // приоткрыта на 60°
    const th = Math.max(6, 11 * view.scale);
    ctx.save();
    if (open) {                                       // проём остаётся отмеченным
      ctx.setLineDash([4, 6]); ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(224,192,99,.45)';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.translate(a.x, a.y); ctx.rotate(ang);
    ctx.globalAlpha = open ? .9 : 1;

    const g = ctx.createLinearGradient(0, -th / 2, 0, th / 2);
    g.addColorStop(0, '#8a5a32'); g.addColorStop(.5, '#6b431f'); g.addColorStop(1, '#4a2d14');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(0, -th / 2, full, th, 2); ctx.fill();

    ctx.strokeStyle = 'rgba(40,24,10,.7)'; ctx.lineWidth = 1;   // стыки досок
    for (let x = full / 5; x < full - 1; x += full / 5) {
      ctx.beginPath(); ctx.moveTo(x, -th / 2 + 1); ctx.lineTo(x, th / 2 - 1); ctx.stroke();
    }
    ctx.fillStyle = '#3c3f46';                                   // железные полосы
    [full * .18, full * .74].forEach((x) => ctx.fillRect(x, -th / 2, Math.max(2, 3 * view.scale), th));
    ctx.strokeStyle = '#241a10'; ctx.lineWidth = 1.5;
    ctx.strokeRect(0, -th / 2, full, th);

    ctx.beginPath();                                             // кольцо-ручка
    ctx.arc(full * .9, 0, Math.max(2, th * .22), 0, Math.PI * 2);
    ctx.strokeStyle = '#c9a45a'; ctx.lineWidth = Math.max(1.5, th * .1); ctx.stroke();
    ctx.restore();
  }

  /** Стены видит только Мастер: игрокам они просто обрезают обзор. */
  function drawWalls() {
    if (!isDM) return;
    const list = wallsOf();
    if (!list.length) return;
    ctx.save();
    list.forEach((w, idx) => {
      const a = w2s(w.x1, w.y1), b = w2s(w.x2, w.y2);
      if (w.type === 'door') drawDoor(a, b, w.open);
      else drawStoneWall(a, b, (w.id || '').length + idx + Math.abs(w.x1 % 97));
      if (tool === 'wall') {                       // ручки для перетаскивания
        [a, b].forEach((p) => {
          ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#171613'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = w.type === 'door' ? '#e0a05a' : '#8fa3c9'; ctx.stroke();
        });
      }
    });
    ctx.restore();
  }

  /** Ближайшая стена под курсором: сначала концы, потом сам отрезок. */
  function wallAt(w) {
    const near = 12 / view.scale;
    const list = wallsOf();
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (Math.hypot(w.x - s.x1, w.y - s.y1) < near) return { wall: s, part: 'a' };
      if (Math.hypot(w.x - s.x2, w.y - s.y2) < near) return { wall: s, part: 'b' };
      if (distToSeg(w, s) < near) return { wall: s, part: 'body' };
    }
    return null;
  }
  function distToSeg(p, s) {
    const vx = s.x2 - s.x1, vy = s.y2 - s.y1;
    const len2 = vx * vx + vy * vy || 1;
    let u = ((p.x - s.x1) * vx + (p.y - s.y1) * vy) / len2;
    u = Math.max(0, Math.min(1, u));
    return Math.hypot(p.x - (s.x1 + u * vx), p.y - (s.y1 + u * vy));
  }
  /** Стены липнут к узлам сетки — так их удобно вести по стенам карты. */
  function snapNode(w, free) {
    if (free) return { x: w.x, y: w.y };
    const g = gridOf();
    return {
      x: g.ox + Math.round((w.x - g.ox) / g.size) * g.size,
      y: g.oy + Math.round((w.y - g.oy) / g.size) * g.size,
    };
  }

  /** Туман: заливаем слой и вырезаем открытые клетки и круги обзора. */
  function drawFog(W, H, b) {
    const l = loc(), g = gridOf();
    const f = fogLayer.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    f.clearRect(0, 0, W, H);
    f.fillStyle = isDM ? 'rgba(12,11,9,.55)' : 'rgba(9,9,8,.98)';
    f.fillRect(0, 0, W, H);

    f.globalCompositeOperation = 'destination-out';
    if (!l.fogAllOpen) {
      // открытые Мастером клетки
      const step = g.size * view.scale;
      Object.keys(l.fog || {}).forEach((k) => {
        const [cx, cy] = k.split(',').map(Number);
        const p = w2s(g.ox + cx * g.size, g.oy + cy * g.size);
        if (p.x > W || p.y > H || p.x + step < 0 || p.y + step < 0) return;
        f.fillRect(p.x - .5, p.y - .5, step + 1, step + 1);
      });
    } else {
      f.fillRect(0, 0, W, H);
    }
    // постоянный обзор вокруг персонажей — обрывается о стены и закрытые двери
    toksHere().forEach((t) => {
      if (!t.vision) return;
      const p = w2s(t.x, t.y);
      const radWorld = (t.vision / g.feet) * g.size;
      const rad = radWorld * view.scale;
      const grd = f.createRadialGradient(p.x, p.y, Math.max(0, rad * .72), p.x, p.y, rad);
      grd.addColorStop(0, 'rgba(0,0,0,1)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      f.fillStyle = grd;
      f.beginPath();
      const shape = visionShape(t, radWorld);
      shape.forEach((q, i) => {
        const sp = w2s(q.x, q.y);
        if (i === 0) f.moveTo(sp.x, sp.y); else f.lineTo(sp.x, sp.y);
      });
      f.closePath(); f.fill();
    });
    f.globalCompositeOperation = 'source-over';
    ctx.drawImage(fogLayer, 0, 0, W, H);
  }

  /* ── попадание в токен ─────────────────────────────────────── */
  function tokenAt(wx, wy) {
    const g = gridOf();
    const list = toksHere();
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (Math.hypot(wx - t.x, wy - t.y) <= (g.size * t.cells) / 2) return t;
    }
    return null;
  }

  /* ── ввод ──────────────────────────────────────────────────── */
  function onDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, evPos(e));
    if (pointers.size === 2) { startPinch(); return; }

    const p = evPos(e);
    const w = s2w(p.x, p.y);
    const mid = e.button === 1 || e.shiftKey;

    // режим «только фигурки»: карта на месте, тянуть можно лишь существ
    if ((tool === 'select' || tool === 'token') && !mid) {
      const t = tokenAt(w.x, w.y);
      if (t && canMove(t)) {
        drag = { type: 'token', id: t.id, dx: t.x - w.x, dy: t.y - w.y, moved: false };
        return;
      }
      // дверь открывается кликом в любом режиме, не только при черчении стен
      if (!t && isDM) {
        const hitW = wallAt(w);
        if (hitW && hitW.wall.type === 'door') {
          drag = { type: 'door-tap', id: hitW.wall.id, open: hitW.wall.open, from: p };
          return;
        }
      }
      if (t || tool === 'token') { drag = { type: 'tap', at: p, id: t && t.id }; return; }
    }
    if (tool === 'ruler' && !mid) {
      ruler = { a: w, b: w };
      drag = { type: 'ruler' }; render(); return;
    }
    if (tool === 'draw' && draw.shape === 'eraser' && !mid) {
      eraseWork = (loc().drawings || []).slice();
      drag = { type: 'erase' };
      eraseStep(w); render(); return;
    }
    if (tool === 'draw' && !mid) {
      preview = { id: 'tmp', by: me.id, shape: draw.shape, color: draw.color, width: draw.width, pts: [w] };
      drag = { type: 'draw' }; render(); return;
    }
    if (tool === 'wall' && isDM && !mid) {
      const hitW = wallAt(w);
      if (e.button === 2 && hitW) {                       // правая кнопка — убрать
        store.dispatch({ t: 'wall.remove', locId: loc().id, id: hitW.wall.id });
        return;
      }
      if (hitW) {                                          // тянем конец или всю стену
        drag = { type: 'wall-move', id: hitW.wall.id, part: hitW.part, from: w, start: { ...hitW.wall } };
        return;
      }
      const a = snapNode(w, e.altKey);
      drag = { type: 'wall-new', a, b: a, free: e.altKey };
      render(); return;
    }
    if (tool === 'fog' && isDM && !mid) {
      // режим кисти задаётся в панели, Alt или правая кнопка переключают на лету
      const on = (e.altKey || e.button === 2) ? fogMode !== 'reveal' : fogMode === 'reveal';
      fogBatch = { cells: new Set(), on };
      drag = { type: 'fog', on, last: p };
      paintFog(w, on); return;
    }
    drag = { type: 'pan', from: p, view: { ...view } };
    canvas.classList.add('is-drag');
  }

  function onMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, evPos(e));
    if (pinch && pointers.size === 2) { doPinch(); return; }

    const p = evPos(e);
    const w = s2w(p.x, p.y);

    if (!drag) {
      if (tool === 'draw' && draw.shape === 'eraser') { hoverAt = p; render(); return; }
      const t = (tool === 'select' || tool === 'token') ? tokenAt(w.x, w.y) : null;
      const id = t ? t.id : null;
      // подсказка курсором: под мышкой дверь, её можно открыть
      if (isDM && !t && (tool === 'select' || tool === 'token')) {
        const hw = wallAt(w);
        canvas.classList.toggle('on-door', !!(hw && hw.wall.type === 'door'));
      }
      if (id !== hoverId) { hoverId = id; render(); }
      return;
    }

    if (drag.type === 'pan') {
      touched = true;
      view.x = drag.view.x + (p.x - drag.from.x);
      view.y = drag.view.y + (p.y - drag.from.y);
      onViewChange && onViewChange(view);
      render();
    } else if (drag.type === 'token') {
      const t = S().tokens[drag.id]; if (!t) return;
      drag.moved = true;
      drag.at = { x: w.x + drag.dx, y: w.y + drag.dy };
      // у себя двигаем сразу, остальным шлём 12 раз в секунду — иначе канал захлёбывается
      t.x = drag.at.x; t.y = drag.at.y;
      render();
      const now = performance.now();
      if (now - (drag.sentAt || 0) > 80) {
        drag.sentAt = now;
        store.dispatch({ t: 'token.update', id: drag.id, patch: { ...drag.at } });
      }
    } else if (drag.type === 'ruler') {
      ruler.b = w; render();
    } else if (drag.type === 'draw') {
      if (preview.shape === 'pen' || preview.shape === 'marker') preview.pts.push(w);
      else preview.pts[1] = w;
      render();
    } else if (drag.type === 'erase') {
      hoverAt = p;
      eraseStep(w);
      render();
    } else if (drag.type === 'fog') {
      drag.last = p;
      paintFog(w, drag.on);
    } else if (drag.type === 'wall-new') {
      drag.b = snapNode(w, drag.free || e.altKey);
      render();
    } else if (drag.type === 'wall-move') {
      const s = drag.start;
      const dx = w.x - drag.from.x, dy = w.y - drag.from.y;
      const snap = (x, y) => snapNode({ x, y }, e.altKey);
      let patch;
      if (drag.part === 'a') { const q = snap(s.x1 + dx, s.y1 + dy); patch = { x1: q.x, y1: q.y }; }
      else if (drag.part === 'b') { const q = snap(s.x2 + dx, s.y2 + dy); patch = { x2: q.x, y2: q.y }; }
      else {
        const q1 = snap(s.x1 + dx, s.y1 + dy);
        patch = { x1: q1.x, y1: q1.y, x2: q1.x + (s.x2 - s.x1), y2: q1.y + (s.y2 - s.y1) };
      }
      drag.moved = true;
      store.dispatch({ t: 'wall.update', locId: loc().id, id: drag.id, patch });
    }
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    canvas.classList.remove('is-drag');
    if (!drag) return;

    if (drag.type === 'token') {
      const t = S().tokens[drag.id];
      if (t) {
        const c = cellCenter(t.x, t.y);
        store.dispatch({ t: 'token.update', id: drag.id, patch: { x: c.x, y: c.y } });
        if (!drag.moved) onTokenOpen && onTokenOpen(t, evPos(e));
      }
    } else if (drag.type === 'wall-new') {
      const { a, b } = drag;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 4) {
        store.dispatch({
          t: 'wall.add', locId: loc().id,
          wall: { id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), type: wallKind, open: false, x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        });
      }
    } else if (drag.type === 'wall-move') {
      // короткий клик по двери без перетаскивания — открыть или закрыть её
      if (!drag.moved && drag.start.type === 'door') {
        store.dispatch({ t: 'wall.update', locId: loc().id, id: drag.id, patch: { open: !drag.start.open } });
      }
    } else if (drag.type === 'door-tap') {
      const p = evPos(e);
      if (Math.hypot(p.x - drag.from.x, p.y - drag.from.y) < 6) {
        store.dispatch({ t: 'wall.update', locId: loc().id, id: drag.id, patch: { open: !drag.open } });
      }
    } else if (drag.type === 'tap') {
      const t = drag.id && S().tokens[drag.id];
      if (t) onTokenOpen && onTokenOpen(t, evPos(e));
    } else if (drag.type === 'draw' && preview) {
      if (preview.pts.length >= 2) {
        store.dispatch({ t: 'draw.add', locId: loc().id, stroke: { ...preview, id: 'd' + Date.now() + Math.random().toString(36).slice(2, 5) } });
      }
      preview = null;
    } else if (drag.type === 'erase' && eraseWork) {
      const before = loc().drawings || [];
      const stayed = new Set(eraseWork.map((d) => d.id));
      const remove = before.filter((d) => !stayed.has(d.id)).map((d) => d.id);
      const had = new Set(before.map((d) => d.id));
      const add = eraseWork.filter((d) => !had.has(d.id));
      if (remove.length) store.dispatch({ t: 'draw.erase', locId: loc().id, remove, add });
      eraseWork = null;
    } else if (drag.type === 'fog' && fogBatch) {
      if (fogBatch.cells.size) {
        store.dispatch({ t: 'fog.paint', locId: loc().id, cells: [...fogBatch.cells], on: fogBatch.on });
      }
      fogBatch = null;
    }
    drag = null;
    render();
  }

  function paintFog(w, on) {
    const g = gridOf();
    const c0x = Math.floor((w.x - g.ox) / g.size), c0y = Math.floor((w.y - g.oy) / g.size);
    // размер кисти — это сторона квадрата в клетках: 1 значит ровно одна клетка
    const n = Math.max(1, fogBrush);
    const half = Math.floor((n - 1) / 2);
    for (let dx = 0; dx < n; dx++) {
      for (let dy = 0; dy < n; dy++) {
        fogBatch.cells.add((c0x - half + dx) + ',' + (c0y - half + dy));
      }
    }
    // мгновенный отклик: правим локально, рассылаем на отпускании
    const l = loc();
    fogBatch.cells.forEach((k) => { if (on) l.fog[k] = 1; else delete l.fog[k]; });
    render();
  }

  function onWheel(e) {
    e.preventDefault();
    const p = evPos(e);
    zoomAt(p, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  function zoomAt(p, k) {
    touched = true;
    const w = s2w(p.x, p.y);
    view.scale = Math.max(.08, Math.min(6, view.scale * k));
    view.x = p.x - w.x * view.scale;
    view.y = p.y - w.y * view.scale;
    onViewChange && onViewChange(view);
    render();
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, scale: view.scale };
    drag = null;
  }
  function doPinch() {
    touched = true;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const w = s2w(pinch.c.x, pinch.c.y);
    view.scale = Math.max(.08, Math.min(6, pinch.scale * (d / pinch.d)));
    view.x = c.x - w.x * view.scale;
    view.y = c.y - w.y * view.scale;
    onViewChange && onViewChange(view);
    render();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('dblclick', (e) => {
    const p = evPos(e); const w = s2w(p.x, p.y);
    const t = tokenAt(w.x, w.y);
    if (t) onTokenOpen && onTokenOpen(t, p);
  });
  new ResizeObserver(resize).observe(canvas);

  const api = {
    render, resize,
    view: () => view,
    ruler: () => ruler && rulerReadout(),
    setTool(t) {
      tool = t; ruler = null;
      canvas.className = t === 'select' ? '' : 'is-' + t;
      render();
    },
    setDraw(patch) { Object.assign(draw, patch); if (patch.shape) { hoverAt = null; render(); } },
    setEraseSize(n) { eraseSize = Math.max(10, n); render(); },
    eraseSize: () => eraseSize,
    setFogBrush(n) { fogBrush = Math.max(1, n); },
    setFogMode(m) { fogMode = m; },
    setWallKind(k) { wallKind = k; },
    /** Для проверок: куда достаёт обзор существа и рисуются ли стены. */
    visionPoints(t) {
      const g = gridOf();
      return visionShape(t, (t.vision / g.feet) * g.size);
    },
    drawsWalls: () => isDM,
    screenToWorld: s2w,
    worldToScreen: w2s,
    cellCenter,
    zoomBy(k) {
      const r = canvas.getBoundingClientRect();
      zoomAt({ x: r.width / 2, y: r.height / 2 }, k);
    },
    fit() {
      const l = loc(); if (!l) return;
      const map = getImage(l.assetId);
      const r = canvas.getBoundingClientRect();
      if (!map) { view = { x: r.width / 2, y: r.height / 2, scale: 1 }; render(); return; }
      const k = Math.min(r.width / map.width, r.height / map.height) * .96;
      view.scale = k;
      view.x = (r.width - map.width * k) / 2;
      view.y = (r.height - map.height * k) / 2;
      onViewChange && onViewChange(view);
      render();
    },
    invalidateAsset(id) { IMG_CACHE.delete(id); render(); },
  };
  return api;
}
