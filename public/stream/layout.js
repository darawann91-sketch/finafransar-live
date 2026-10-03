// Multi-camera layout for a live with guests on stage: one big video + small
// tiles. Provider-agnostic: an item's video is anything with attach(el) /
// detach(el) (a LiveKit track, or a wrapped local MediaStreamTrack).
//
//   const L = createLayout({ main: videoEl, tiles: containerEl, onTileClick })
//   L.set(id, { video, name, mirror })   L.remove(id)
//   L.setStage(mainId, [ids in order])   // 'host' resolves to the host's identity
//
// `external` ids are on stage but drawn by the caller (the studio draws the
// host's own camera itself), so they never get a tile or the main slot here.

export function wrapLocalTrack(mediaTrack) {
  return {
    attach(el) {
      el.srcObject = new MediaStream([mediaTrack]);
      el.play?.().catch(() => {});
    },
    detach(el) {
      el.srcObject = null;
    },
  };
}

export function createLayout({ main, tiles, onTileClick, onMain, external = [], hostPrefix = 'host-' }) {
  const items = new Map(); // id -> { video, name, mirror }
  const tileEls = new Map(); // id -> { wrap, video, label, src }
  const ext = new Set(external);
  let stageMain = 'host';
  let order = ['host'];
  let mainSrc = null;
  let mainId = null;

  const resolve = (id) => {
    if (id !== 'host' || ext.has('host')) return id;
    for (const k of items.keys()) if (k.startsWith(hostPrefix)) return k;
    return id;
  };

  function swap(el, from, to) {
    if (from === to) return;
    try { from?.detach(el); } catch {}
    if (to) {
      try { to.attach(el); } catch {}
      el.play?.().catch(() => {});
    } else {
      el.srcObject = null;
    }
  }

  function render() {
    const ids = order.map(resolve);
    let m = resolve(stageMain);
    // If the chosen camera isn't connected (yet), fall back to the host / first live camera.
    if (!ext.has(m) && !items.get(m)?.video) {
      const host = resolve('host');
      m = ext.has(host) || items.get(host)?.video ? host : ids.find((id) => items.get(id)?.video) ?? host;
    }
    if (m !== mainId) {
      mainId = m;
      onMain?.(m);
    }
    if (main) {
      const it = ext.has(m) ? null : items.get(m);
      swap(main, mainSrc, it?.video || null);
      mainSrc = it?.video || null;
      main.classList.toggle('mirror', !!it?.mirror);
      main.dataset.camera = ext.has(m) ? 'external' : m || '';
    }
    if (!tiles) return;
    const want = ids.filter((id) => id !== m && !ext.has(id));
    for (const [id, t] of tileEls) {
      if (!want.includes(id)) {
        swap(t.video, t.src, null);
        t.wrap.remove();
        tileEls.delete(id);
      }
    }
    want.forEach((id, i) => {
      const it = items.get(id) || {};
      let t = tileEls.get(id);
      if (!t) {
        const wrap = document.createElement('div');
        wrap.className = 'gtile';
        wrap.dataset.id = id;
        const video = document.createElement('video');
        video.playsInline = true;
        video.autoplay = true;
        video.muted = true; // audio is played separately
        video.setAttribute('playsinline', '');
        const label = document.createElement('span');
        label.className = 'gtile-name';
        wrap.append(video, label);
        if (onTileClick) {
          wrap.classList.add('clickable');
          wrap.addEventListener('click', (e) => {
            e.stopPropagation();
            onTileClick(wrap.dataset.id);
          });
        }
        t = { wrap, video, label, src: null };
        tileEls.set(id, t);
      }
      swap(t.video, t.src, it.video || null);
      t.src = it.video || null;
      t.video.classList.toggle('mirror', !!it.mirror);
      t.wrap.classList.toggle('waiting', !it.video);
      t.label.textContent = it.name || '';
      if (tiles.children[i] !== t.wrap) tiles.insertBefore(t.wrap, tiles.children[i] || null);
    });
    tiles.dataset.count = String(want.length);
  }

  return {
    set(id, patch) {
      items.set(id, { ...(items.get(id) || {}), ...patch });
      render();
    },
    remove(id) {
      items.delete(id);
      render();
    },
    setStage(mainTarget, ids) {
      stageMain = mainTarget || 'host';
      order = ids && ids.length ? ids : ['host'];
      render();
    },
    // Point the layout at new elements (after the page re-rendered) and redraw.
    rebind(els) {
      for (const t of tileEls.values()) {
        swap(t.video, t.src, null);
        t.wrap.remove();
      }
      tileEls.clear();
      if (main) swap(main, mainSrc, null);
      mainSrc = null;
      main = els.main || null;
      tiles = els.tiles || null;
      render();
    },
    has: (id) => items.has(id),
    get mainId() {
      return mainId;
    },
    clear() {
      for (const t of tileEls.values()) {
        swap(t.video, t.src, null);
        t.wrap.remove();
      }
      tileEls.clear();
      if (main) swap(main, mainSrc, null);
      mainSrc = null;
      items.clear();
    },
  };
}
