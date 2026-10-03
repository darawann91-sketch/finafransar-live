// Token-bucket rate limiter (in-memory, per process). Good for a single
// instance. When running several instances put this behind Redis.
export class RateLimiter {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
    this._gc = setInterval(() => this.gc(), 60_000);
    this._gc.unref?.();
  }

  take(key, cost = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, ts: now };
      this.buckets.set(key, b);
    }
    const elapsed = (now - b.ts) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.ts = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return true;
    }
    return false;
  }

  gc() {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (now - b.ts > 10 * 60_000) this.buckets.delete(k);
    }
  }
}

// Fixed-window counter, e.g. "max 4 previews per IP per hour".
export class WindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.map = new Map();
  }
  hit(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || now - e.start > this.windowMs) {
      e = { start: now, count: 0 };
      this.map.set(key, e);
    }
    e.count++;
    if (this.map.size > 50_000) this.map.clear();
    return e.count;
  }
  reset(key) {
    this.map.delete(key);
  }
}
