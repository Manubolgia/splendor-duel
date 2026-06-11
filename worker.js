// Splendor Duel — Cloudflare Worker + Durable Object
// Authoritative game state lives in the GameRoom Durable Object.
// Clients connect via WebSocket and send intents; the engine validates,
// applies, and broadcasts a per-seat sanitized state.

// ---------------------------------------------------------------------------
// Game data
// ---------------------------------------------------------------------------

const COLORS = ['w', 'u', 'g', 'r', 'k']; // white, blue, green, red, black
const TOKEN_SUPPLY = { w: 4, u: 4, g: 4, r: 4, k: 4, p: 2, o: 3 }; // p=pearl, o=gold

// Board refill order: outward spiral from the center of the 5x5 grid.
const SPIRAL = [12, 13, 18, 17, 16, 11, 6, 7, 8, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5, 0, 1, 2, 3, 4];

// Royal cards: claimed at 3 crowns and again at 6 crowns.
const ROYALS = [
  { id: 'R0', pts: 3, ab: null },
  { id: 'R1', pts: 2, ab: 'again' },
  { id: 'R2', pts: 2, ab: 'steal' },
  { id: 'R3', pts: 2, ab: 'priv' },
];

function others(c) {
  const i = COLORS.indexOf(c);
  return [1, 2, 3, 4].map((d) => COLORS[(i + d) % 5]);
}

// Card abilities: 'take' = take a board token of the card's color,
// 'steal' = take a token from the opponent, 'priv' = gain a privilege,
// 'again' = play another turn. b: bonus color, 'x' = wild (assign to an
// existing bonus color), null = no bonus.
function buildDecks() {
  let id = 0;
  const C = (cost, b, pts = 0, crowns = 0, ab = null) => ({ id: id++, cost, b, pts, crowns, ab });
  const t1 = [], t2 = [], t3 = [];
  for (const c of COLORS) {
    const [o1, o2, o3] = others(c);
    t1.push(C({ [o1]: 3 }, c));
    t1.push(C({ [o1]: 2, [o2]: 2 }, c));
    t1.push(C({ [o1]: 2, [o2]: 1, [o3]: 1 }, c));
    t1.push(C({ [o2]: 2, p: 1 }, c, 0, 0, 'take'));
    t1.push(C({ [o1]: 2, [o2]: 2, [o3]: 1 }, c, 1));
    t1.push(C({ [o3]: 3, p: 1 }, c, 0, 1));
  }
  for (const c of COLORS) {
    const [o1, o2, o3] = others(c);
    t2.push(C({ [o1]: 4, [o2]: 2 }, c, 2));
    t2.push(C({ [o1]: 3, [o2]: 2, p: 1 }, c, 1, 1));
    t2.push(C({ [o1]: 4, [o2]: 3 }, c, 2, 0, 'steal'));
    t2.push(C({ [o1]: 3, [o3]: 2, p: 1 }, c, 1, 0, 'priv'));
  }
  t2.push(C({ w: 3, u: 3, p: 1 }, 'x', 1));
  t2.push(C({ g: 3, r: 3, p: 1 }, 'x', 1));
  t2.push(C({ k: 3, w: 3, p: 1 }, 'x', 1));
  t2.push(C({ u: 3, g: 3, p: 1 }, 'x', 1));
  for (const c of COLORS) {
    const [o1, o2, o3] = others(c);
    t3.push(C({ [o1]: 5, [o2]: 3 }, c, 4));
    t3.push(C({ [o1]: 4, [o2]: 2, [o3]: 2, p: 1 }, c, 3, 2, 'again'));
  }
  t3.push(C({ w: 2, u: 2, g: 2, r: 2, k: 2 }, null, 6));
  t3.push(C({ r: 5, k: 3, p: 1 }, 'x', 5));
  t3.push(C({ w: 4, g: 4, p: 1 }, 'x', 4, 0, 'steal'));
  t1.forEach((x) => (x.t = 1));
  t2.forEach((x) => (x.t = 2));
  t3.forEach((x) => (x.t = 3));
  return { 1: t1, 2: t2, 3: t3 };
}

// ---------------------------------------------------------------------------
// Game engine
// ---------------------------------------------------------------------------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function zeroTokens() {
  return { w: 0, u: 0, g: 0, r: 0, k: 0, p: 0, o: 0 };
}
function zeroColors() {
  return { w: 0, u: 0, g: 0, r: 0, k: 0 };
}

function newGame(names, firstSeat = 0) {
  const bag = [];
  for (const [c, n] of Object.entries(TOKEN_SUPPLY)) for (let i = 0; i < n; i++) bag.push(c);
  shuffle(bag);
  const decks = buildDecks();
  shuffle(decks[1]); shuffle(decks[2]); shuffle(decks[3]);
  const open = {
    1: decks[1].splice(0, 5),
    2: decks[2].splice(0, 4),
    3: decks[3].splice(0, 3),
  };
  const players = [0, 1].map((i) => ({
    name: names[i] || `Player ${i + 1}`,
    tokens: zeroTokens(),
    bonus: zeroColors(),
    cardPts: zeroColors(),
    points: 0,
    crowns: 0,
    priv: 0,
    reserved: [],
    royals: [],
    royalsTaken: 0,
    cardCount: 0,
  }));
  // The player going second starts with one privilege.
  players[1 - firstSeat].priv = 1;
  const st = {
    phase: 'playing',
    board: Array(25).fill(null),
    bag,
    decks,
    open,
    royals: ROYALS.slice(),
    privSupply: 2,
    players,
    turn: firstSeat,
    firstSeat,
    pending: [],
    again: false,
    done: false,
    winner: null,
    winReason: null,
    log: [],
  };
  refillBoard(st);
  log(st, `Game started — ${players[firstSeat].name} goes first.`);
  return st;
}

function log(st, msg) {
  st.log.push(msg);
  if (st.log.length > 60) st.log.splice(0, st.log.length - 60);
}

function refillBoard(st) {
  for (const i of SPIRAL) {
    if (!st.bag.length) break;
    if (st.board[i] === null) st.board[i] = st.bag.pop();
  }
}

function tokenTotal(p) {
  return Object.values(p.tokens).reduce((a, b) => a + b, 0);
}

// Privilege goes to `seat`: from the supply if possible, otherwise taken
// from the opponent. Max 3 privileges exist.
function givePriv(st, seat) {
  const me = st.players[seat], op = st.players[1 - seat];
  if (st.privSupply > 0) { st.privSupply--; me.priv++; }
  else if (op.priv > 0) { op.priv--; me.priv++; }
}

function lineOK(cells) {
  if (cells.length === 1) return true;
  const pts = cells.map((i) => [Math.floor(i / 5), i % 5]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const dr = pts[1][0] - pts[0][0], dc = pts[1][1] - pts[0][1];
  if (Math.abs(dr) > 1 || Math.abs(dc) > 1 || (dr === 0 && dc === 0)) return false;
  for (let i = 2; i < pts.length; i++) {
    if (pts[i][0] - pts[i - 1][0] !== dr || pts[i][1] - pts[i - 1][1] !== dc) return false;
  }
  return true;
}

// Compute the payment for a card: tokens first, gold covers any shortfall.
// Returns {pay, goldNeeded} or null if unaffordable.
function computePayment(p, card) {
  const pay = zeroTokens();
  let goldNeeded = 0;
  for (const [c, n] of Object.entries(card.cost)) {
    const discount = c === 'p' ? 0 : (p.bonus[c] || 0);
    const owe = Math.max(0, n - discount);
    const fromTokens = Math.min(owe, p.tokens[c]);
    pay[c] = fromTokens;
    goldNeeded += owe - fromTokens;
  }
  if (goldNeeded > p.tokens.o) return null;
  pay.o = goldNeeded;
  return pay;
}

function removeOpenCard(st, tier, idx) {
  const card = st.open[tier][idx];
  st.open[tier][idx] = st.decks[tier].length ? st.decks[tier].pop() : null;
  return card;
}

const ABILITY_TEXT = { take: 'takes a matching gem', steal: 'steals a token', priv: 'gains a privilege', again: 'plays again' };

function applyCardEffects(st, seat, card) {
  const me = st.players[seat], op = st.players[1 - seat];
  if (card.b === 'x') {
    st.pending.push({ type: 'color', pts: card.pts, cardId: card.id });
  } else if (card.b === null) {
    me.points += card.pts;
  } else {
    me.bonus[card.b]++;
    me.cardPts[card.b] += card.pts;
    me.points += card.pts;
  }
  me.cardCount++;
  if (card.crowns) {
    me.crowns += card.crowns;
    queueRoyals(st, seat);
  }
  if (card.ab === 'again') st.again = true;
  if (card.ab === 'priv') givePriv(st, seat);
  if (card.ab === 'take' && card.b !== 'x') {
    for (const i of SPIRAL) {
      if (st.board[i] === card.b) {
        st.board[i] = null;
        me.tokens[card.b]++;
        log(st, `${me.name} ${ABILITY_TEXT.take}.`);
        break;
      }
    }
  }
  if (card.ab === 'steal' && COLORS.concat('p').some((c) => op.tokens[c] > 0)) {
    st.pending.push({ type: 'steal' });
  }
}

function queueRoyals(st, seat) {
  const me = st.players[seat];
  let earned = 0;
  if (me.crowns >= 3) earned++;
  if (me.crowns >= 6) earned++;
  let queued = st.pending.filter((p) => p.type === 'royal').length;
  while (me.royalsTaken + queued < earned && st.royals.length > queued) {
    st.pending.push({ type: 'royal' });
    queued++;
  }
}

function checkWin(st, seat) {
  const me = st.players[seat];
  if (me.points >= 20) return 'points';
  if (me.crowns >= 10) return 'crowns';
  for (const c of COLORS) if (me.cardPts[c] >= 10) return 'color';
  return null;
}

// Called after every action/resolve. Ends the turn once the mandatory action
// is done and all pending choices are resolved.
function maybeEndTurn(st) {
  if (st.phase !== 'playing' || !st.done || st.pending.length) return;
  const seat = st.turn;
  const me = st.players[seat];
  if (tokenTotal(me) > 10) {
    st.pending.push({ type: 'discard', count: tokenTotal(me) - 10 });
    return;
  }
  const reason = checkWin(st, seat);
  if (reason) {
    st.phase = 'over';
    st.winner = seat;
    st.winReason = reason;
    const why = { points: '20 prestige points', crowns: '10 crowns', color: '10 points in one color' }[reason];
    log(st, `${me.name} wins with ${why}!`);
    return;
  }
  st.done = false;
  if (st.again) {
    st.again = false;
    log(st, `${me.name} takes another turn.`);
  } else {
    st.turn = 1 - seat;
  }
}

const GEM_NAMES = { w: 'white', u: 'blue', g: 'green', r: 'red', k: 'black', p: 'pearl', o: 'gold' };

// Apply an action. Returns an error string, or null on success (state mutated).
function applyAction(st, seat, a) {
  if (st.phase !== 'playing') return 'Game is not in progress.';
  if (seat !== st.turn) return 'Not your turn.';
  const me = st.players[seat], op = st.players[1 - seat];

  // Pending choices must be resolved before anything else.
  if (st.pending.length) {
    const pend = st.pending[0];
    if (a.type !== 'resolve') return 'Resolve the pending choice first.';
    const r = a.resolve || {};
    if (r.type !== pend.type) return 'Unexpected resolution.';
    if (pend.type === 'color') {
      if (!COLORS.includes(r.color) || me.bonus[r.color] < 1) return 'Pick a color you already own.';
      me.bonus[r.color]++;
      me.cardPts[r.color] += pend.pts;
      me.points += pend.pts;
      log(st, `${me.name} assigns a wild card to ${GEM_NAMES[r.color]}.`);
    } else if (pend.type === 'steal') {
      if (!COLORS.concat('p').includes(r.color) || op.tokens[r.color] < 1) return 'Opponent has no such token.';
      op.tokens[r.color]--;
      me.tokens[r.color]++;
      log(st, `${me.name} steals a ${GEM_NAMES[r.color]} token.`);
    } else if (pend.type === 'royal') {
      const idx = r.idx | 0;
      if (idx < 0 || idx >= st.royals.length) return 'Invalid royal card.';
      const royal = st.royals.splice(idx, 1)[0];
      me.royals.push(royal);
      me.royalsTaken++;
      me.points += royal.pts;
      log(st, `${me.name} claims a royal card (${royal.pts} pts).`);
      if (royal.ab === 'again') st.again = true;
      if (royal.ab === 'priv') givePriv(st, seat);
      if (royal.ab === 'steal' && COLORS.concat('p').some((c) => op.tokens[c] > 0)) {
        st.pending.splice(1, 0, { type: 'steal' });
      }
    } else if (pend.type === 'discard') {
      const t = r.tokens || {};
      let total = 0;
      for (const [c, n] of Object.entries(t)) {
        if (!(c in me.tokens) || n < 0 || n > me.tokens[c]) return 'Invalid discard.';
        total += n;
      }
      if (total !== pend.count) return `You must discard exactly ${pend.count} token(s).`;
      for (const [c, n] of Object.entries(t)) {
        me.tokens[c] -= n;
        for (let i = 0; i < n; i++) st.bag.push(c);
      }
      shuffle(st.bag);
      log(st, `${me.name} discards ${pend.count} token(s).`);
    }
    st.pending.shift();
    maybeEndTurn(st);
    return null;
  }

  switch (a.type) {
    case 'privilege': {
      // Optional action: spend a privilege scroll to take one non-gold token.
      if (st.done) return 'Your turn is over.';
      if (me.priv < 1) return 'No privileges to spend.';
      const i = a.cell | 0;
      const tok = st.board[i];
      if (!tok || tok === 'o') return 'Pick a gem or pearl on the board.';
      me.priv--;
      st.privSupply++;
      st.board[i] = null;
      me.tokens[tok]++;
      log(st, `${me.name} uses a privilege to take a ${GEM_NAMES[tok]} token.`);
      return null;
    }
    case 'replenish': {
      // Optional action: refill the board; opponent gains a privilege.
      if (st.done) return 'Your turn is over.';
      if (!st.bag.length) return 'The bag is empty.';
      if (!st.board.some((t) => t === null)) return 'The board is already full.';
      givePriv(st, 1 - seat);
      refillBoard(st);
      log(st, `${me.name} replenishes the board — ${op.name} gains a privilege.`);
      return null;
    }
    case 'take': {
      const cells = [...new Set((a.cells || []).map((x) => x | 0))];
      if (cells.length < 1 || cells.length > 3) return 'Take 1 to 3 tokens.';
      if (cells.some((i) => i < 0 || i > 24 || !st.board[i] || st.board[i] === 'o')) {
        return 'You can only take gems and pearls from the board.';
      }
      if (!lineOK(cells)) return 'Tokens must be adjacent in a straight line.';
      const taken = cells.map((i) => st.board[i]);
      cells.forEach((i) => (st.board[i] = null));
      taken.forEach((t) => me.tokens[t]++);
      const pearls = taken.filter((t) => t === 'p').length;
      const sameThree = taken.length === 3 && taken.every((t) => t === taken[0]);
      if (pearls === 2 || sameThree) {
        givePriv(st, 1 - seat);
        log(st, `${me.name} takes ${taken.map((t) => GEM_NAMES[t]).join(', ')} — ${op.name} gains a privilege.`);
      } else {
        log(st, `${me.name} takes ${taken.map((t) => GEM_NAMES[t]).join(', ')}.`);
      }
      st.done = true;
      maybeEndTurn(st);
      return null;
    }
    case 'reserve': {
      if (me.reserved.length >= 3) return 'You already have 3 reserved cards.';
      const goldCell = st.board.findIndex((t) => t === 'o');
      if (goldCell === -1) return 'No gold on the board — you cannot reserve.';
      let card;
      if (a.kind === 'open') {
        card = (st.open[a.tier] || [])[a.idx];
        if (!card) return 'No card there.';
        removeOpenCard(st, a.tier, a.idx);
        card.pub = true;
      } else if (a.kind === 'deck') {
        if (!(st.decks[a.tier] || []).length) return 'That deck is empty.';
        card = st.decks[a.tier].pop();
        card.pub = false;
      } else return 'Invalid reserve.';
      st.board[goldCell] = null;
      me.tokens.o++;
      me.reserved.push(card);
      log(st, `${me.name} reserves a tier ${card.t} card and takes a gold token.`);
      st.done = true;
      maybeEndTurn(st);
      return null;
    }
    case 'buy': {
      let card, take;
      if (a.kind === 'open') {
        card = (st.open[a.tier] || [])[a.idx];
        if (!card) return 'No card there.';
        take = () => removeOpenCard(st, a.tier, a.idx);
      } else if (a.kind === 'reserved') {
        card = me.reserved[a.idx];
        if (!card) return 'No such reserved card.';
        take = () => me.reserved.splice(a.idx, 1)[0];
      } else return 'Invalid purchase.';
      if (card.b === 'x' && !COLORS.some((c) => me.bonus[c] > 0)) {
        return 'You need at least one bonus card to buy a wild card.';
      }
      const pay = computePayment(me, card);
      if (!pay) return 'You cannot afford that card.';
      for (const [c, n] of Object.entries(pay)) {
        me.tokens[c] -= n;
        for (let i = 0; i < n; i++) st.bag.push(c);
      }
      shuffle(st.bag);
      take();
      log(st, `${me.name} buys a tier ${card.t} card${card.pts ? ` (${card.pts} pts)` : ''}.`);
      applyCardEffects(st, seat, card);
      st.done = true;
      maybeEndTurn(st);
      return null;
    }
    default:
      return 'Unknown action.';
  }
}

// Per-seat sanitized view: hides the bag order, deck contents, and the
// opponent's face-down reserved cards.
function publicState(st, seat) {
  const s = JSON.parse(JSON.stringify(st));
  s.bagCount = s.bag.length;
  delete s.bag;
  s.deckCounts = { 1: s.decks[1].length, 2: s.decks[2].length, 3: s.decks[3].length };
  delete s.decks;
  s.players.forEach((p, i) => {
    if (i !== seat) {
      p.reserved = p.reserved.map((c) => (c.pub ? c : { hidden: true, t: c.t }));
    }
  });
  return s;
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
      this.room = { game: null, seats: [], createdAt: Date.now() };
      await this.save();
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
        room.game = newGame(room.seats.map((s) => s.name), 0);
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
      this.room.game = newGame(this.room.seats.map((s) => s.name), first);
      await this.save();
      this.broadcast();
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
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch('https://room/create');
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
