// Throwaway engine test: plays random legal games to completion.

import * as fs from 'fs';

// Re-import internals by evaluating the module source with exports exposed.
const src = fs.readFileSync('./worker.js', 'utf8');
const mod = await import('data:text/javascript,' + encodeURIComponent(
  src + '\nexport { newGame, applyAction, publicState, lineOK, computePayment, COLORS };'
));
const { newGame, applyAction, publicState, lineOK } = mod;

const COLORS = ['w', 'u', 'g', 'r', 'k'];
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function legalActions(st) {
  const seat = st.turn;
  const me = st.players[seat], op = st.players[1 - seat];
  const acts = [];
  if (st.pending.length) {
    const p = st.pending[0];
    if (p.type === 'color') {
      for (const c of COLORS) if (me.bonus[c] > 0) acts.push({ type: 'resolve', resolve: { type: 'color', color: c } });
    } else if (p.type === 'steal') {
      for (const c of [...COLORS, 'p']) if (op.tokens[c] > 0) acts.push({ type: 'resolve', resolve: { type: 'steal', color: c } });
    } else if (p.type === 'royal') {
      for (let i = 0; i < st.royals.length; i++) acts.push({ type: 'resolve', resolve: { type: 'royal', idx: i } });
    } else if (p.type === 'discard') {
      // discard greedily from largest piles
      const t = { ...me.tokens };
      const d = { w: 0, u: 0, g: 0, r: 0, k: 0, p: 0, o: 0 };
      let left = p.count;
      while (left > 0) {
        const c = Object.keys(t).sort((a, b) => t[b] - t[a])[0];
        t[c]--; d[c]++; left--;
      }
      acts.push({ type: 'resolve', resolve: { type: 'discard', tokens: d } });
    }
    return acts;
  }
  // takes: all single cells + some lines
  const filled = [];
  for (let i = 0; i < 25; i++) if (st.board[i] && st.board[i] !== 'o') filled.push(i);
  for (const i of filled) acts.push({ type: 'take', cells: [i] });
  for (const i of filled) for (const j of filled) for (const k of filled) {
    if (i < j && j < k && lineOK([i, j, k])) acts.push({ type: 'take', cells: [i, j, k] });
  }
  // buys
  for (const tier of [1, 2, 3]) {
    st.open[tier].forEach((card, idx) => {
      if (!card) return;
      if (card.b === 'x' && !COLORS.some((c) => me.bonus[c] > 0)) return;
      if (mod.computePayment(me, card)) acts.push({ type: 'buy', kind: 'open', tier, idx });
    });
  }
  me.reserved.forEach((card, idx) => {
    if (card.b === 'x' && !COLORS.some((c) => me.bonus[c] > 0)) return;
    if (mod.computePayment(me, card)) acts.push({ type: 'buy', kind: 'reserved', idx });
  });
  // reserve
  if (me.reserved.length < 3 && st.board.includes('o')) {
    for (const tier of [1, 2, 3]) {
      st.open[tier].forEach((card, idx) => { if (card) acts.push({ type: 'reserve', kind: 'open', tier, idx }); });
    }
  }
  // privilege / replenish
  if (me.priv > 0 && filled.length) acts.push({ type: 'privilege', cell: pick(filled) });
  if (st.bag && st.bag.length && st.board.some((x) => x === null)) acts.push({ type: 'replenish' });
  return acts;
}

let wins = { points: 0, crowns: 0, color: 0 };
for (let game = 0; game < 300; game++) {
  const st = newGame(['A', 'B'], 0);
  let steps = 0;
  while (st.phase === 'playing' && steps < 3000) {
    const acts = legalActions(st);
    if (!acts.length) {
      // no legal action at all: must be a stalled state — fail loudly
      console.error('STALL at step', steps, JSON.stringify({
        turn: st.turn, pending: st.pending, done: st.done,
        bag: st.bag.length, board: st.board.filter(Boolean).length,
        tokens: st.players.map((p) => p.tokens), priv: st.players.map((p) => p.priv),
      }));
      process.exit(1);
    }
    const a = pick(acts);
    const err = applyAction(st, st.turn, a);
    if (err) {
      console.error('REJECTED supposedly-legal action:', JSON.stringify(a), '→', err);
      process.exit(1);
    }
    steps++;
  }
  if (st.phase !== 'over') {
    console.error('Game did not finish in 3000 steps');
    process.exit(1);
  }
  wins[st.winReason]++;
  globalThis.LAST = st;
  globalThis.ROYALS = (globalThis.ROYALS || 0) + st.players[0].royals.length + st.players[1].royals.length;
  globalThis.MAXCROWNS = Math.max(globalThis.MAXCROWNS || 0, st.players[0].crowns, st.players[1].crowns);
  // invariants
  const total = st.bag.length + st.board.filter(Boolean).length +
    st.players.reduce((s, p) => s + Object.values(p.tokens).reduce((a, b) => a + b, 0), 0);
  if (total !== 25) { console.error('Token conservation broken:', total); process.exit(1); }
  const privTotal = st.privSupply + st.players[0].priv + st.players[1].priv;
  if (privTotal !== 3) { console.error('Privilege conservation broken:', privTotal); process.exit(1); }
  // sanitization must not leak
  const pub = publicState(st, 0);
  if (pub.bag || pub.decks) { console.error('Sanitization leak'); process.exit(1); }
}
console.log('300 games OK. Win reasons:', wins);
console.log('total royals claimed:', globalThis.ROYALS, '| max crowns seen:', globalThis.MAXCROWNS);
