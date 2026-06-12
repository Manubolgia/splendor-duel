// Integration test: two players join a room and play random legal moves
// against the local wrangler dev server until someone wins.
const BASE = 'http://127.0.0.1:8787';
const COLORS = ['w', 'u', 'g', 'r', 'k'];
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function lineOK(cells) {
  if (cells.length <= 1) return cells.length === 1;
  const pts = cells.map((i) => [Math.floor(i / 5), i % 5]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const dr = pts[1][0] - pts[0][0], dc = pts[1][1] - pts[0][1];
  if (Math.abs(dr) > 1 || Math.abs(dc) > 1 || (dr === 0 && dc === 0)) return false;
  for (let i = 2; i < pts.length; i++)
    if (pts[i][0] - pts[i - 1][0] !== dr || pts[i][1] - pts[i - 1][1] !== dc) return false;
  return true;
}
function affordable(p, card) {
  if (!card || card.hidden) return false;
  if (card.b === 'x' && !COLORS.some((c) => p.bonus[c] > 0)) return false;
  let gold = 0;
  for (const [c, n] of Object.entries(card.cost)) {
    const disc = c === 'p' ? 0 : (p.bonus[c] || 0);
    gold += Math.max(0, Math.max(0, n - disc) - p.tokens[c]);
  }
  return gold <= p.tokens.o;
}

function legalActions(st, seat) {
  const me = st.players[seat], op = st.players[1 - seat];
  const acts = [];
  if (st.pending.length) {
    const p = st.pending[0];
    if (p.type === 'color') for (const c of COLORS) { if (me.bonus[c] > 0) acts.push({ type: 'resolve', resolve: { type: 'color', color: c } }); }
    else if (p.type === 'steal') for (const c of [...COLORS, 'p']) { if (op.tokens[c] > 0) acts.push({ type: 'resolve', resolve: { type: 'steal', color: c } }); }
    else if (p.type === 'royal') for (let i = 0; i < st.royals.length; i++) acts.push({ type: 'resolve', resolve: { type: 'royal', idx: i } });
    else if (p.type === 'discard') {
      const t = { ...me.tokens }, d = { w: 0, u: 0, g: 0, r: 0, k: 0, p: 0, o: 0 };
      let left = p.count;
      while (left-- > 0) { const c = Object.keys(t).sort((a, b) => t[b] - t[a])[0]; t[c]--; d[c]++; }
      acts.push({ type: 'resolve', resolve: { type: 'discard', tokens: d } });
    }
    return acts;
  }
  const filled = [];
  for (let i = 0; i < 25; i++) if (st.board[i] && st.board[i] !== 'o') filled.push(i);
  for (const i of filled) acts.push({ type: 'take', cells: [i] });
  for (const i of filled) for (const j of filled) for (const k of filled)
    if (i < j && j < k && lineOK([i, j, k])) acts.push({ type: 'take', cells: [i, j, k] });
  for (const tier of [1, 2, 3]) st.open[tier].forEach((card, idx) => {
    if (affordable(me, card)) acts.push({ type: 'buy', kind: 'open', tier, idx });
  });
  me.reserved.forEach((card, idx) => { if (affordable(me, card)) acts.push({ type: 'buy', kind: 'reserved', idx }); });
  if (me.reserved.length < 3 && st.board.includes('o'))
    for (const tier of [1, 2, 3]) st.open[tier].forEach((card, idx) => { if (card) acts.push({ type: 'reserve', kind: 'open', tier, idx }); });
  if (st.bagCount > 0 && st.board.some((x) => x === null)) acts.push({ type: 'replenish' });
  return acts;
}

const res = await fetch(BASE + '/api/create', { method: 'POST' });
const { code } = await res.json();
console.log('room:', code);

let moves = 0, errors = 0, finished = null;

function player(name) {
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${code}?name=${name}`);
  let seat = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'joined') seat = m.seat;
    if (m.t === 'error') { console.error(`[${name}] server rejected:`, m.msg); errors++; }
    if (m.t === 'state' && m.state) {
      const st = m.state;
      if (st.phase === 'over') {
        if (!finished) {
          finished = true;
          console.log(`game over after ${moves} moves — winner seat ${st.winner} by ${st.winReason}`);
          console.log('last log:', st.log.slice(-2).map((l) => l.msg ?? l).join(' | '));
          // verify sanitization: opponent's deck-reserved cards must be hidden
          const oppRes = st.players[1 - m.seat].reserved;
          if (oppRes.some((c) => !c.pub && !c.hidden)) { console.error('LEAK: face-down reserved card visible'); process.exit(1); }
          process.exit(errors ? 1 : 0);
        }
        return;
      }
      if (st.turn !== m.seat) return;
      const acts = legalActions(st, m.seat);
      if (!acts.length) { console.error('no legal actions!'); process.exit(1); }
      moves++;
      if (moves > 4000) { console.error('runaway'); process.exit(1); }
      ws.send(JSON.stringify({ t: 'action', action: pick(acts) }));
    }
  };
  return ws;
}

player('Alice');
setTimeout(() => player('Bob'), 300);
setTimeout(() => { console.error('timeout — game did not finish'); process.exit(1); }, 120000);
