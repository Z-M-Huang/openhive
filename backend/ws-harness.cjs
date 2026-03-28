'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = parseInt(process.env.HARNESS_PORT || '9876', 10);
const TRAFFIC_CAP = 10000;
const NOTIF_CAP = 1000;
const DEFAULT_WS_URL = 'ws://localhost:8080/ws';

let globalSeq = 0;
const connections = new Map(); // name -> Connection
const trafficLog = [];         // { seq, connection, direction, type, content, ts }

// --- Connection class ---

class Connection {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.ws = null;
    this.state = 'connecting';
    this.sent = 0;
    this.received = 0;
    this.notifications = [];
    this.pendingResolve = null;   // for /send — { resolve, exchange, timeout }
    this.pendingExchanges = [];   // for /exchange — [{ resolve, sinceSeq, terminalCount, timeout }]
    this.draining = false;        // true after /send timeout — discard frames until terminal
    this.disposed = false;        // true after close() — ignore all further frames
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        this.state = 'error';
        return reject(err);
      }

      const openTimeout = setTimeout(() => {
        this.state = 'error';
        reject(new Error('ws connect timeout (10s)'));
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(openTimeout);
        this.state = 'open';
        resolve();
      });

      this.ws.on('message', (data) => {
        // Ignore frames on disposed connections (after /reset or /shutdown)
        if (this.disposed) return;

        this.received++;
        const seq = ++globalSeq;
        let parsed;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          parsed = { type: 'raw', content: data.toString() };
        }
        const type = parsed.type || 'unknown';
        const entry = {
          seq,
          connection: this.name,
          direction: 'recv',
          type,
          content: parsed.content || parsed.error || '',
          raw: parsed,
          ts: new Date().toISOString(),
        };
        pushTraffic(entry);

        // Notification: buffer separately (not affected by draining)
        if (type === 'notification') {
          if (this.notifications.length >= NOTIF_CAP) this.notifications.shift();
          this.notifications.push({ seq, content: parsed.content || '', ts: entry.ts });
          // Also check pending exchanges (notifications don't count as terminal)
          this._checkPendingExchanges(seq);
          return;
        }

        // Draining: after a /send timeout, discard non-notification frames until
        // the timed-out request's terminal frame arrives, preventing late responses
        // from being misattributed to the next /send request.
        if (this.draining) {
          if (type === 'response' || type === 'error') {
            this.draining = false;
          }
          // Still check pending exchanges (for /send_fire -> /exchange flow)
          this._checkPendingExchanges(seq);
          return;
        }

        // If we have a pending /send, accumulate
        if (this.pendingResolve) {
          this.pendingResolve.exchange.push({ seq, type, content: parsed.content || parsed.error || '', ts: entry.ts });
          if (type === 'response' || type === 'error') {
            const pr = this.pendingResolve;
            this.pendingResolve = null;
            clearTimeout(pr.timeout);
            pr.resolve({
              ok: true,
              exchange: pr.exchange,
              final: parsed.content || parsed.error || '',
              elapsed: Date.now() - pr.startTime,
            });
          }
          return;
        }

        // No pending send — check pending exchanges (from /send_fire -> /exchange)
        this._checkPendingExchanges(seq);
      });

      this.ws.on('close', () => {
        this.state = 'closed';
        if (this.pendingResolve) {
          const pr = this.pendingResolve;
          this.pendingResolve = null;
          clearTimeout(pr.timeout);
          pr.resolve({ ok: false, error: `closed during exchange`, partialExchange: pr.exchange });
        }
        this._rejectPendingExchanges('connection closed');
      });

      this.ws.on('error', (err) => {
        clearTimeout(openTimeout);
        this.state = 'error';
        if (this.pendingResolve) {
          const pr = this.pendingResolve;
          this.pendingResolve = null;
          clearTimeout(pr.timeout);
          pr.resolve({ ok: false, error: `ws error: ${err.message}`, partialExchange: pr.exchange });
        }
        this._rejectPendingExchanges(`ws error: ${err.message}`);
      });
    });
  }

  _checkPendingExchanges(latestSeq) {
    for (let i = this.pendingExchanges.length - 1; i >= 0; i--) {
      const pe = this.pendingExchanges[i];
      // Exclude notification frames from exchange results
      const frames = trafficLog.filter(
        (e) => e.connection === this.name && e.direction === 'recv' && e.seq > pe.sinceSeq && e.type !== 'notification'
      );
      // Count terminal frames (response/error) — resolve when we reach the requested count
      const terminalCount = frames.filter((f) => f.type === 'response' || f.type === 'error').length;
      if (terminalCount >= pe.terminalCount) {
        this.pendingExchanges.splice(i, 1);
        clearTimeout(pe.timeout);
        pe.resolve({
          ok: true,
          frames: frames.map((f) => ({ seq: f.seq, type: f.type, content: f.content, ts: f.ts })),
        });
      }
    }
  }

  _rejectPendingExchanges(reason) {
    for (const pe of this.pendingExchanges) {
      clearTimeout(pe.timeout);
      pe.resolve({ ok: false, error: reason });
    }
    this.pendingExchanges = [];
  }

  close() {
    this.disposed = true;
    if (this.pendingResolve) {
      const pr = this.pendingResolve;
      this.pendingResolve = null;
      clearTimeout(pr.timeout);
      pr.resolve({ ok: false, error: 'connection closed by /disconnect or /reset', partialExchange: pr.exchange });
    }
    this._rejectPendingExchanges('connection closed by /disconnect or /reset');
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
    }
    this.state = 'closed';
  }
}

function pushTraffic(entry) {
  if (trafficLog.length >= TRAFFIC_CAP) trafficLog.shift();
  trafficLog.push(entry);
}

// --- HTTP API ---

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

async function parseJSON(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleRequest(req, res) {
  const url = req.url.split('?')[0];

  // GET /status
  if (req.method === 'GET' && url === '/status') {
    const conns = {};
    for (const [name, c] of connections) {
      conns[name] = { state: c.state, sent: c.sent, received: c.received };
    }
    return json(res, { ok: true, connections: conns, trafficSize: trafficLog.length });
  }

  // All other endpoints are POST
  if (req.method !== 'POST') {
    return json(res, { ok: false, error: `method not allowed: ${req.method}` }, 405);
  }

  const body = await parseJSON(req);
  if (body === null) {
    return json(res, { ok: false, error: 'invalid request JSON' }, 400);
  }

  // POST /connect
  if (url === '/connect') {
    const name = body.name;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const existing = connections.get(name);
    if (existing && existing.state === 'open') {
      return json(res, { ok: false, error: `connection '${name}' already open, use /reconnect or /disconnect first` });
    }
    const wsUrl = body.url || DEFAULT_WS_URL;
    const conn = new Connection(name, wsUrl);
    connections.set(name, conn);
    try {
      await conn.connect();
      return json(res, { ok: true, name });
    } catch (err) {
      connections.delete(name);
      return json(res, { ok: false, error: `ws failed: ${err.message}` });
    }
  }

  // POST /reconnect
  if (url === '/reconnect') {
    const name = body.name;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const existing = connections.get(name);
    if (existing) existing.close();
    const wsUrl = body.url || DEFAULT_WS_URL;
    const conn = new Connection(name, wsUrl);
    connections.set(name, conn);
    try {
      await conn.connect();
      return json(res, { ok: true, name });
    } catch (err) {
      connections.delete(name);
      return json(res, { ok: false, error: `ws failed: ${err.message}` });
    }
  }

  // POST /disconnect
  if (url === '/disconnect') {
    const name = body.name;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const conn = connections.get(name);
    if (conn) conn.close();
    return json(res, { ok: true });
  }

  // POST /send
  if (url === '/send') {
    const name = body.name;
    const content = body.content;
    const timeout = body.timeout || 300000;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const conn = connections.get(name);
    if (!conn) return json(res, { ok: false, error: `no connection '${name}'` });
    if (conn.state !== 'open') return json(res, { ok: false, error: `connection '${name}' not open` });
    if (conn.pendingResolve) return json(res, { ok: false, error: `send pending on '${name}'` });

    const startTime = Date.now();
    const result = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (conn.pendingResolve) {
          const pr = conn.pendingResolve;
          conn.pendingResolve = null;
          conn.draining = true; // Discard late frames from this timed-out request
          resolve({ ok: false, error: 'timeout', partialExchange: pr.exchange, elapsed: Date.now() - startTime });
        }
      }, timeout);

      conn.pendingResolve = { resolve, exchange: [], timeout: timeoutId, startTime };

      const seq = ++globalSeq;
      const payload = JSON.stringify({ content });
      conn.ws.send(payload);
      conn.sent++;
      pushTraffic({ seq, connection: name, direction: 'send', type: 'message', content, ts: new Date().toISOString() });
    });

    return json(res, result);
  }

  // POST /send_raw
  if (url === '/send_raw') {
    const name = body.name;
    const payload = body.payload;
    const timeout = body.timeout || 30000;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    if (payload === undefined) return json(res, { ok: false, error: 'payload required' }, 400);
    const conn = connections.get(name);
    if (!conn) return json(res, { ok: false, error: `no connection '${name}'` });
    if (conn.state !== 'open') return json(res, { ok: false, error: `connection '${name}' not open` });
    if (conn.pendingResolve) return json(res, { ok: false, error: `send pending on '${name}'` });

    const startTime = Date.now();
    const result = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (conn.pendingResolve) {
          const pr = conn.pendingResolve;
          conn.pendingResolve = null;
          conn.draining = true; // Discard late frames from this timed-out request
          resolve({ ok: false, error: 'timeout', partialExchange: pr.exchange, elapsed: Date.now() - startTime });
        }
      }, timeout);

      conn.pendingResolve = { resolve, exchange: [], timeout: timeoutId, startTime };

      const seq = ++globalSeq;
      conn.ws.send(String(payload));
      conn.sent++;
      pushTraffic({ seq, connection: name, direction: 'send', type: 'raw', content: String(payload), ts: new Date().toISOString() });
    });

    return json(res, result);
  }

  // POST /send_fire
  if (url === '/send_fire') {
    const name = body.name;
    const content = body.content;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const conn = connections.get(name);
    if (!conn) return json(res, { ok: false, error: `no connection '${name}'` });
    if (conn.state !== 'open') return json(res, { ok: false, error: `connection '${name}' not open` });

    // Fire-and-forget: send without waiting, no serialization check
    const seq = ++globalSeq;
    const payload = JSON.stringify({ content });
    conn.ws.send(payload);
    conn.sent++;
    pushTraffic({ seq, connection: name, direction: 'send', type: 'fire', content, ts: new Date().toISOString() });

    return json(res, { ok: true, sent: true });
  }

  // POST /exchange
  if (url === '/exchange') {
    const name = body.name;
    const sinceSeq = body.since_seq || 0;
    const timeout = body.timeout || 300000;
    const terminalCount = body.terminal_count || 1; // Wait for N terminal frames (response/error)
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const conn = connections.get(name);
    if (!conn) return json(res, { ok: false, error: `no connection '${name}'` });

    // Check if we already have enough terminal frames since sinceSeq (exclude notifications)
    const existing = trafficLog.filter(
      (e) => e.connection === name && e.direction === 'recv' && e.seq > sinceSeq && e.type !== 'notification'
    );
    const terminals = existing.filter((f) => f.type === 'response' || f.type === 'error').length;
    if (terminals >= terminalCount) {
      return json(res, {
        ok: true,
        frames: existing.map((f) => ({ seq: f.seq, type: f.type, content: f.content, ts: f.ts })),
      });
    }

    // Wait for enough terminal frames
    const result = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        const idx = conn.pendingExchanges.findIndex((pe) => pe.resolve === resolve);
        if (idx >= 0) conn.pendingExchanges.splice(idx, 1);
        const partial = trafficLog.filter(
          (e) => e.connection === name && e.direction === 'recv' && e.seq > sinceSeq && e.type !== 'notification'
        );
        resolve({
          ok: false,
          error: 'timeout',
          frames: partial.map((f) => ({ seq: f.seq, type: f.type, content: f.content, ts: f.ts })),
        });
      }, timeout);

      conn.pendingExchanges.push({ resolve, sinceSeq, terminalCount, timeout: timeoutId });
    });

    return json(res, result);
  }

  // POST /notifications
  if (url === '/notifications') {
    const name = body.name;
    const sinceSeq = body.since_seq || 0;
    const clear = body.clear || false;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const conn = connections.get(name);
    if (!conn) return json(res, { ok: false, error: `no connection '${name}'` });

    const filtered = conn.notifications.filter((n) => n.seq > sinceSeq);
    const count = filtered.length;
    if (clear) conn.notifications = conn.notifications.filter((n) => n.seq <= sinceSeq);

    return json(res, { ok: true, notifications: filtered, count });
  }

  // POST /traffic
  if (url === '/traffic') {
    const name = body.name;
    const typeFilter = body.type;
    const direction = body.direction;
    const limit = body.limit || 50;

    let entries = [...trafficLog];
    if (name) entries = entries.filter((e) => e.connection === name);
    if (typeFilter) entries = entries.filter((e) => e.type === typeFilter);
    if (direction) entries = entries.filter((e) => e.direction === direction);

    const total = entries.length;
    entries = entries.slice(-limit);

    return json(res, {
      ok: true,
      entries: entries.map((e) => ({
        seq: e.seq,
        connection: e.connection,
        direction: e.direction,
        type: e.type,
        content: (e.content || '').slice(0, 500),
        ts: e.ts,
      })),
      total,
    });
  }

  // POST /reset
  if (url === '/reset') {
    for (const [, conn] of connections) conn.close();
    connections.clear();
    trafficLog.length = 0;
    globalSeq = 0;
    return json(res, { ok: true });
  }

  // POST /shutdown
  if (url === '/shutdown') {
    for (const [, conn] of connections) conn.close();
    connections.clear();
    json(res, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  return json(res, { ok: false, error: `unknown endpoint: ${url}` }, 404);
}

// --- Start ---

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[harness] Error handling ${req.method} ${req.url}:`, err.message);
    try { json(res, { ok: false, error: err.message }, 500); } catch {}
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ws-harness] Ready on http://127.0.0.1:${PORT}`);
});

server.on('error', (err) => {
  console.error(`[ws-harness] Failed to start: ${err.message}`);
  process.exit(1);
});
