// Reconnecting websocket with a tiny event emitter.
export function createSocket({ url, getToken, liveId, onStatus }) {
  const handlers = new Map();
  let ws = null;
  let closedByUs = false;
  let attempt = 0;
  let queue = [];
  let pingTimer = null;

  const emit = (type, msg) => (handlers.get(type) || []).slice().forEach((fn) => fn(msg));

  async function connect() {
    let token;
    try {
      token = await getToken();
    } catch {
      return retry();
    }
    ws = new WebSocket(`${url}?live=${encodeURIComponent(liveId)}&token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      attempt = 0;
      onStatus?.('open');
      queue.forEach((m) => ws.send(m));
      queue = [];
      emit('open');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ t: 'ping' }), 20_000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      emit(msg.t, msg);
      emit('*', msg);
    };
    ws.onclose = (ev) => {
      clearInterval(pingTimer);
      if (closedByUs) return;
      if (ev.code === 4003) return onStatus?.('blocked');
      if (ev.code === 4004) return onStatus?.('unavailable');
      onStatus?.('reconnecting');
      retry();
    };
    ws.onerror = () => {};
  }

  function retry() {
    attempt++;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) * (0.7 + Math.random() * 0.6);
    setTimeout(connect, delay);
  }

  function send(msg) {
    const data = JSON.stringify(msg);
    if (ws && ws.readyState === 1) ws.send(data);
    else if (queue.length < 20 && msg.t !== 'ping' && msg.t !== 'like') queue.push(data);
  }

  // Reconnect immediately when the phone comes back online / to foreground.
  window.addEventListener('online', () => {
    if (!ws || ws.readyState > 1) { attempt = 0; connect(); }
  });

  connect();
  return {
    send,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
      return () => handlers.set(type, (handlers.get(type) || []).filter((f) => f !== fn));
    },
    close() {
      closedByUs = true;
      clearInterval(pingTimer);
      ws?.close();
    },
    get open() {
      return ws?.readyState === 1;
    },
  };
}
