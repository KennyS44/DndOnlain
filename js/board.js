// Поле боя: карта, сетка, токены, туман войны, рисование, линейка.
// Всё рисуется в один canvas — так проще держать зум и перетаскивание согласованными.

const IMG_CACHE = new Map();

export function createBoard(opts) {
  const { canvas, store, sync, me, isDM, onTokenOpen, onViewChange } = opts;
  const ctx = canvas.getContext('2d');

  let view = { x: 0, y: 0, scale: 1 };
  let tool = 'select';
  let draw = { shape: 'pen', color: '#c9a45a', width: 4 };
  let fogBrush = 2;

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

  function canMove(t) { return isDM || t.ownerId === me.id; }

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
    drawStrokes(l.drawings);
    if (preview) drawStroke(preview, true);
    drawTokens();
    if (l.fogOn) drawFog(W, H, bounds);
    if (ruler) drawRuler();
    if (drag && drag.type === 'fog') drawBrushCursor();
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
    if (t.ownerId) return '#7fa8c9';
    return t.kind === 'enemy' ? '#b8604a' : t.kind === 'pc' ? '#83a05f' : '#8d7440';
  }

  function drawStrokes(list) { list.forEach((d) => drawStroke(d, false)); }

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
        labelFeet(a, b, rr);
      } else if (d.shape === 'cone') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x), rr = Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        ctx.arc(a.x, a.y, rr, ang - .45, ang + .45); ctx.closePath();
        ctx.stroke(); ctx.globalAlpha = .14; ctx.fill();
        labelFeet(a, b, rr);
      }
    }
    ctx.restore();
  }

  function labelFeet(a, b, rPx) {
    const ft = Math.round((rPx / view.scale) * feetPerPx());
    ctx.globalAlpha = 1; ctx.font = '12px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(ft + ' фт', a.x, a.y - 6);
  }

  function drawRuler() {
    const a = w2s(ruler.a.x, ruler.a.y), b = w2s(ruler.b.x, ruler.b.y);
    const g = gridOf();
    const dxc = (ruler.b.x - ruler.a.x) / g.size, dyc = (ruler.b.y - ruler.a.y) / g.size;
    // по правилам D&D 5e диагональ считается как обычный шаг
    const cells = Math.max(Math.abs(dxc), Math.abs(dyc));
    const feet = Math.round(cells * g.feet);
    ctx.save();
    ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = '#c9a45a';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    [a, b].forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#c9a45a'; ctx.fill(); });
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const txt = `${feet} фт · ${Math.round(cells)} кл`;
    ctx.font = '14px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(23,22,19,.88)';
    ctx.fillRect(mx - tw / 2 - 8, my - 14, tw + 16, 26);
    ctx.strokeStyle = '#38332b'; ctx.lineWidth = 1;
    ctx.strokeRect(mx - tw / 2 - 8, my - 14, tw + 16, 26);
    ctx.fillStyle = '#ece6d9'; ctx.fillText(txt, mx, my);
    ctx.restore();
  }

  function drawBrushCursor() {
    const g = gridOf();
    const p = drag.last;
    if (!p) return;
    ctx.save();
    ctx.strokeStyle = drag.on ? '#83a05f' : '#b8604a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, fogBrush * g.size * view.scale, 0, Math.PI * 2);
    ctx.stroke(); ctx.restore();
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
      Object.keys(l.fog).forEach((k) => {
        const [cx, cy] = k.split(',').map(Number);
        const p = w2s(g.ox + cx * g.size, g.oy + cy * g.size);
        if (p.x > W || p.y > H || p.x + step < 0 || p.y + step < 0) return;
        f.fillRect(p.x - .5, p.y - .5, step + 1, step + 1);
      });
    } else {
      f.fillRect(0, 0, W, H);
    }
    // постоянный обзор вокруг персонажей
    toksHere().forEach((t) => {
      if (!t.vision) return;
      const p = w2s(t.x, t.y);
      const rad = (t.vision / g.feet) * g.size * view.scale;
      const grd = f.createRadialGradient(p.x, p.y, Math.max(0, rad * .7), p.x, p.y, rad);
      grd.addColorStop(0, 'rgba(0,0,0,1)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      f.fillStyle = grd;
      f.beginPath(); f.arc(p.x, p.y, rad, 0, Math.PI * 2); f.fill();
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

    if (tool === 'select' && !mid) {
      const t = tokenAt(w.x, w.y);
      if (t && canMove(t)) {
        drag = { type: 'token', id: t.id, dx: t.x - w.x, dy: t.y - w.y, moved: false };
        return;
      }
      if (t) { drag = { type: 'pan', from: p, view: { ...view } }; return; }
    }
    if (tool === 'ruler' && !mid) {
      ruler = { a: w, b: w };
      drag = { type: 'ruler' }; render(); return;
    }
    if (tool === 'draw' && !mid) {
      preview = { id: 'tmp', by: me.id, shape: draw.shape, color: draw.color, width: draw.width, pts: [w] };
      drag = { type: 'draw' }; render(); return;
    }
    if (tool === 'fog' && isDM && !mid) {
      const on = !(e.altKey || e.button === 2);
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
      const t = tool === 'select' ? tokenAt(w.x, w.y) : null;
      const id = t ? t.id : null;
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
      const nx = w.x + drag.dx, ny = w.y + drag.dy;
      store.dispatch({ t: 'token.update', id: drag.id, patch: { x: nx, y: ny } });
    } else if (drag.type === 'ruler') {
      ruler.b = w; render();
    } else if (drag.type === 'draw') {
      if (preview.shape === 'pen' || preview.shape === 'marker') preview.pts.push(w);
      else preview.pts[1] = w;
      render();
    } else if (drag.type === 'fog') {
      drag.last = p;
      paintFog(w, drag.on);
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
    } else if (drag.type === 'draw' && preview) {
      if (preview.pts.length >= 2) {
        store.dispatch({ t: 'draw.add', locId: loc().id, stroke: { ...preview, id: 'd' + Date.now() + Math.random().toString(36).slice(2, 5) } });
      }
      preview = null;
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
    const r = fogBrush;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.hypot(dx, dy) > r) continue;
        fogBatch.cells.add((c0x + dx) + ',' + (c0y + dy));
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
    setTool(t) {
      tool = t; ruler = null;
      canvas.className = t === 'select' ? '' : 'is-' + t;
      render();
    },
    setDraw(patch) { Object.assign(draw, patch); },
    setFogBrush(n) { fogBrush = n; },
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
