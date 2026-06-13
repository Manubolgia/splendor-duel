// Splendor Duel — Cloudflare Worker + Durable Object
// Authoritative game state lives in the GameRoom Durable Object.
// Clients connect via WebSocket and send intents; the engine validates,
// applies, and broadcasts a per-seat sanitized state.
//
// The game rules live in engine.js (shared with the browser for offline play).

import './engine.js';
const { newGame, applyAction, publicState, DEFAULT_RULES } = globalThis.SplendorEngine;

// Parse a "points-crowns-color" rules string (e.g. "22-7-9") into a rules
// object, or null (engine then falls back to the official defaults). Only the
// two shipped presets are accepted; anything else falls back to traditional.
function parseRules(s) {
  if (!s) return null;
  const m = /^(\d+)-(\d+)-(\d+)$/.exec(s);
  if (!m) return null;
  const r = { points: +m[1], crowns: +m[2], color: +m[3] };
  const ok = (a, b) => a.points === b.points && a.crowns === b.crowns && a.color === b.color;
  if (ok(r, DEFAULT_RULES) || ok(r, { points: 22, crowns: 7, color: 9 })) return r;
  return null;
}

// ---------------------------------------------------------------------------
// Durable Object: one room per 4-letter code
// ---------------------------------------------------------------------------

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null; // { game, seats: [{token,name}], createdAt }
  }

  async load() {
    if (!this.room) this.room = (await this.state.storage.get('room')) || null;
    return this.room;
  }

  async save() {
    await this.state.storage.put('room', this.room);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/create') {
      const room = await this.load();
      const fresh = !room || room.game?.phase === 'over' || Date.now() - room.createdAt > 12 * 3600 * 1000;
      if (!fresh) return new Response('busy', { status: 409 });
      const rules = parseRules(url.searchParams.get('rules'));
      this.room = { game: null, seats: [], createdAt: Date.now(), rules };
      await this.save();
      return new Response('ok');
    }

    if (url.pathname === '/close') {
      const room = await this.load();
      if (!room) return new Response('gone');
      const token = url.searchParams.get('token') || '';
      if (!room.seats.some((s) => s.token === token)) {
        return new Response('forbidden', { status: 403 });
      }
      await this.teardown();
      return new Response('ok');
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const room = await this.load();
      if (!room) return new Response('Room not found', { status: 404 });

      const token = url.searchParams.get('token') || '';
      const name = (url.searchParams.get('name') || '').slice(0, 16);

      let seat = room.seats.findIndex((s) => token && s.token === token);
      if (seat === -1) {
        if (room.seats.length >= 2) return new Response('Room is full', { status: 403 });
        seat = room.seats.length;
        room.seats.push({
          token: crypto.randomUUID(),
          name: name || `Player ${seat + 1}`,
        });
      } else if (name) {
        room.seats[seat].name = name;
      }

      if (room.seats.length === 2 && !room.game) {
        room.game = newGame(room.seats.map((s) => s.name), 0, room.rules);
      }
      await this.save();

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ seat });
      server.send(JSON.stringify({ t: 'joined', seat, token: room.seats[seat].token, code: url.searchParams.get('code') || '' }));
      this.broadcast();
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  connectedSeats() {
    const seats = new Set();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att) seats.add(att.seat);
    }
    return seats;
  }

  broadcast() {
    if (!this.room) return;
    const present = [...this.connectedSeats()];
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att) continue;
      const msg = {
        t: 'state',
        seat: att.seat,
        names: this.room.seats.map((s) => s.name),
        present,
        state: this.room.game ? publicState(this.room.game, att.seat) : null,
      };
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    await this.load();
    if (!this.room) return;

    if (msg.t === 'action' && this.room.game) {
      const err = applyAction(this.room.game, att.seat, msg.action || {});
      if (err) {
        try { ws.send(JSON.stringify({ t: 'error', msg: err })); } catch {}
        return;
      }
      await this.save();
      this.broadcast();
    } else if (msg.t === 'rematch' && this.room.game && this.room.game.phase === 'over') {
      // Loser of the previous game (or the other player) goes first.
      const first = 1 - this.room.game.firstSeat;
      this.room.game = newGame(this.room.seats.map((s) => s.name), first, this.room.rules);
      await this.save();
      this.broadcast();
    } else if (msg.t === 'leave') {
      await this.teardown();
    }
  }

  // Tear down the room: tell every connected client the room closed,
  // drop the state, and close sockets.
  async teardown() {
    for (const sock of this.state.getWebSockets()) {
      try { sock.send(JSON.stringify({ t: 'closed' })); } catch {}
    }
    this.room = null;
    await this.state.storage.delete('room');
    for (const sock of this.state.getWebSockets()) {
      try { sock.close(1000, 'room closed'); } catch {}
    }
  }

  async webSocketClose() {
    await this.load();
    this.broadcast();
  }

  async webSocketError() {
    await this.load();
    this.broadcast();
  }
}

// ---------------------------------------------------------------------------
// Worker: routing + room codes
// ---------------------------------------------------------------------------

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O — avoids confusion

function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === '/api/create' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const rulesQ = parseRules(body.rules) ? '?rules=' + encodeURIComponent(body.rules) : '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch('https://room/create' + rulesQ);
        if (res.ok) {
          return new Response(JSON.stringify({ code }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }
      return new Response(JSON.stringify({ error: 'Could not allocate a room.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    if (url.pathname === '/api/close' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const code = String(body.code || '').toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) {
        return new Response(JSON.stringify({ error: 'Bad code.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      const res = await stub.fetch('https://room/close?token=' + encodeURIComponent(body.token || ''), { method: 'POST' });
      return new Response(JSON.stringify({ ok: res.ok }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      const target = new URL('https://room/ws');
      target.search = url.search;
      target.searchParams.set('code', code);
      return stub.fetch(new Request(target, request));
    }

    return new Response('Splendor Duel server', { headers: CORS });
  },
};
