// Splendor Duel — shared game engine + AI.
// Loaded by the Cloudflare Worker (authoritative online games) and by the
// browser (offline games vs the AI / pass-and-play). Plain script: it exposes
// everything on globalThis.SplendorEngine so it works in both environments.

(() => {
'use strict';

// ---------------------------------------------------------------------------
// Game data
// ---------------------------------------------------------------------------

const COLORS = ['w', 'u', 'g', 'r', 'k']; // white, blue, green, red, black
const TOKEN_SUPPLY = { w: 4, u: 4, g: 4, r: 4, k: 4, p: 2, o: 3 }; // p=pearl, o=gold

// Board refill order: outward spiral from the center of the 5x5 grid.
const SPIRAL = [12, 13, 18, 17, 16, 11, 6, 7, 8, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5, 0, 1, 2, 3, 4];

// Royal cards: claimed at 3 crowns and again at 6 crowns. Per the official
// rules, royals carry NO crowns — crowns only ever come from jewel cards. They
// grant prestige points and an ability.
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

// Card abilities: 'take' = take a board token of the card's color ("take a 2nd
// of the same gem"), 'steal' = take a token from the opponent, 'priv' = gain a
// privilege, 'again' = play another turn. b: bonus color, 'x' = wild (assign to
// an existing bonus color you own), null = no bonus. bv: bonus value (cards that
// grant 2 of their color; defaults to 1).
//
// Card data is a faithful transcription of the official Splendor Duel card list
// (Splendor_Duel_Card_List-v3). Cost color codes: p=pearl, k=black, r=red,
// g=green, u=blue, w=white. Per-level totals: L1 30 cards / 11 pts / 6 crowns,
// L2 24 / 37 / 9, L3 13 / 44 / 13.
function buildDecks() {
  let id = 0;
  // (cost, bonus, pts, crowns, ability, bonusValue)
  const C = (cost, b, pts = 0, crowns = 0, ab = null, bv = 1) => ({ id: id++, cost, b, pts, crowns, ab, bv });

  const t1 = [
    // Black bonus
    C({ r: 1, g: 1, u: 1, w: 1 }, 'k'),
    C({ p: 1, u: 2, w: 2 }, 'k', 0, 0, 'again'),
    C({ r: 2, g: 2 }, 'k', 0, 0, 'take'),
    C({ g: 3, u: 2 }, 'k', 1),
    C({ w: 3 }, 'k', 0, 1),
    // Red bonus
    C({ k: 1, g: 1, u: 1, w: 1 }, 'r'),
    C({ p: 1, k: 2, w: 2 }, 'r', 0, 0, 'again'),
    C({ g: 2, u: 2 }, 'r', 0, 0, 'take'),
    C({ u: 3, w: 2 }, 'r', 1),
    C({ k: 3 }, 'r', 0, 1),
    // Green bonus
    C({ k: 1, r: 1, u: 1, w: 1 }, 'g'),
    C({ p: 1, k: 2, r: 2 }, 'g', 0, 0, 'again'),
    C({ u: 2, w: 2 }, 'g', 0, 0, 'take'),
    C({ k: 2, w: 3 }, 'g', 1),
    C({ r: 3 }, 'g', 0, 1),
    // Blue bonus
    C({ k: 1, r: 1, g: 1, w: 1 }, 'u'),
    C({ p: 1, r: 2, g: 2 }, 'u', 0, 0, 'again'),
    C({ k: 2, w: 2 }, 'u', 0, 0, 'take'),
    C({ k: 3, r: 2 }, 'u', 1),
    C({ g: 3 }, 'u', 0, 1),
    // White bonus
    C({ k: 1, r: 1, g: 1, u: 1 }, 'w'),
    C({ p: 1, g: 2, u: 2 }, 'w', 0, 0, 'again'),
    C({ k: 2, r: 2 }, 'w', 0, 0, 'take'),
    C({ r: 3, g: 2 }, 'w', 1),
    C({ u: 3 }, 'w', 0, 1),
    // Specials
    C({ p: 1, r: 4 }, null, 3),
    C({ p: 1, k: 4 }, 'x', 1),
    C({ p: 1, w: 4 }, 'x', 0, 1),
    C({ p: 1, k: 1, g: 2, w: 2 }, 'x', 1),
    C({ p: 1, k: 1, r: 2, u: 2 }, 'x', 1),
  ];

  const t2 = [
    // Black bonus
    C({ g: 3, w: 4 }, 'k', 1, 0, 'steal'),
    C({ u: 2, w: 5 }, 'k', 1, 0, null, 2),
    C({ p: 1, r: 2, g: 2, u: 2 }, 'k', 2, 1),
    C({ p: 1, k: 4, r: 2 }, 'k', 2, 0, 'priv'),
    // Red bonus
    C({ k: 4, u: 3 }, 'r', 1, 0, 'steal'),
    C({ k: 5, w: 2 }, 'r', 1, 0, null, 2),
    C({ p: 1, g: 2, u: 2, w: 2 }, 'r', 2, 1),
    C({ p: 1, r: 4, g: 2 }, 'r', 2, 0, 'priv'),
    // Green bonus
    C({ r: 4, w: 3 }, 'g', 1, 0, 'steal'),
    C({ k: 2, r: 5 }, 'g', 1, 0, null, 2),
    C({ p: 1, k: 2, u: 2, w: 2 }, 'g', 2, 1),
    C({ p: 1, g: 4, u: 2 }, 'g', 2, 0, 'priv'),
    // Blue bonus
    C({ k: 3, g: 4 }, 'u', 1, 0, 'steal'),
    C({ r: 2, g: 5 }, 'u', 1, 0, null, 2),
    C({ p: 1, k: 2, r: 2, w: 2 }, 'u', 2, 1),
    C({ p: 1, u: 4, w: 2 }, 'u', 2, 0, 'priv'),
    // White bonus
    C({ r: 3, u: 4 }, 'w', 1, 0, 'steal'),
    C({ g: 2, u: 5 }, 'w', 1, 0, null, 2),
    C({ p: 1, k: 2, r: 2, g: 2 }, 'w', 2, 1),
    C({ p: 1, k: 2, w: 4 }, 'w', 2, 0, 'priv'),
    // Specials
    C({ p: 1, u: 6 }, null, 5),
    C({ p: 1, g: 6 }, 'x', 2),
    C({ p: 1, g: 6 }, 'x', 0, 2),
    C({ p: 1, u: 6 }, 'x', 0, 2),
  ];

  const t3 = [
    C({ p: 1, r: 3, g: 5, w: 3 }, 'k', 3, 2),
    C({ k: 6, r: 2, w: 2 }, 'k', 4),
    C({ p: 1, k: 3, g: 3, u: 5 }, 'r', 3, 2),
    C({ k: 2, r: 6, g: 2 }, 'r', 4),
    C({ p: 1, r: 3, u: 3, w: 5 }, 'g', 3, 2),
    C({ r: 2, g: 6, u: 2 }, 'g', 4),
    C({ p: 1, k: 5, g: 3, w: 3 }, 'u', 3, 2),
    C({ g: 2, u: 6, w: 2 }, 'u', 4),
    C({ p: 1, k: 3, r: 5, u: 3 }, 'w', 3, 2),
    C({ k: 2, u: 2, w: 6 }, 'w', 4),
    // Specials
    C({ w: 8 }, null, 6),
    C({ k: 8 }, 'x', 0, 3),
    C({ r: 8 }, 'x', 3, 0, 'again'),
  ];

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

// Default win thresholds — the official ("traditional") Splendor Duel rules.
const DEFAULT_RULES = { points: 20, crowns: 10, color: 10 };

function normalizeRules(rules) {
  const r = rules || {};
  return {
    points: r.points || DEFAULT_RULES.points,
    crowns: r.crowns || DEFAULT_RULES.crowns,
    color: r.color || DEFAULT_RULES.color,
  };
}

function newGame(names, firstSeat = 0, rules = null) {
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
    rules: normalizeRules(rules),
    board: Array(25).fill(null),
    bag,
    decks,
    open,
    royals: ROYALS.slice(),
    privSupply: 2,
    players,
    turn: firstSeat,
    firstSeat,
    turnNo: 1,
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
  st.log.push({ n: st.turnNo, msg });
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
    me.bonus[card.b] += card.bv || 1;
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
  const R = st.rules || DEFAULT_RULES;
  if (me.points >= R.points) return 'points';
  if (me.crowns >= R.crowns) return 'crowns';
  for (const c of COLORS) if (me.cardPts[c] >= R.color) return 'color';
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
    const R = st.rules || DEFAULT_RULES;
    const why = { points: `${R.points} prestige points`, crowns: `${R.crowns} crowns`, color: `${R.color} points in one color` }[reason];
    log(st, `${me.name} wins with ${why}!`);
    return;
  }
  st.done = false;
  if (st.again) {
    st.again = false;
    log(st, `${me.name} takes another turn.`);
  } else {
    st.turn = 1 - seat;
    st.turnNo++;
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
      // If the opponent ran out of tokens (e.g. two steals queued at once),
      // the steal fizzles instead of blocking the game.
      if (COLORS.concat('p').some((c) => op.tokens[c] > 0)) {
        if (!COLORS.concat('p').includes(r.color) || op.tokens[r.color] < 1) return 'Opponent has no such token.';
        op.tokens[r.color]--;
        me.tokens[r.color]++;
        log(st, `${me.name} steals a ${GEM_NAMES[r.color]} token.`);
      } else {
        log(st, `${me.name} has nothing to steal.`);
      }
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
      const dropped = Object.entries(t).filter(([, n]) => n > 0)
        .map(([c, n]) => `${n}× ${GEM_NAMES[c]}`).join(', ');
      log(st, `${me.name} discards ${dropped}.`);
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
      const cardColor = card.b === 'x' ? 'wild' : (card.b ? GEM_NAMES[card.b] : '');
      const desc = `${cardColor ? cardColor + ' ' : ''}tier ${card.t} card`;
      log(st, `${me.name} buys a ${desc}${card.pts ? ` (${card.pts} pts)` : ''}.`);
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
// AI opponent — picks one action for `seat` on the current state.
// level: 'easy' (random-ish), 'medium' (greedy with noisy judgement),
// 'hard' (pure greedy + blocks the opponent's winning card). It only looks
// at open information: face-up cards, its own reserved cards, tokens —
// never the bag or deck order.
// ---------------------------------------------------------------------------

const AB_SCORE = { again: 2.5, steal: 1.5, take: 1, priv: 1.2 };

function aiCardScore(st, seat, card, level) {
  const me = st.players[seat];
  const R = st.rules || DEFAULT_RULES;
  let s = card.pts * 3 + (card.crowns || 0) * 2.5 + (card.ab ? AB_SCORE[card.ab] : 0);
  if (card.b) s += 1.2;
  // Immediate win conditions dominate everything else.
  if (me.points + card.pts >= R.points) s += 1000;
  if (me.crowns + (card.crowns || 0) >= R.crowns) s += 1000;
  if (card.b && card.b !== 'x' && me.cardPts[card.b] + card.pts >= R.color) s += 1000;
  if (card.b === 'x' && COLORS.some((c) => me.bonus[c] > 0 && me.cardPts[c] + card.pts >= R.color)) s += 1000;
  return s;
}

// How much each token color is worth chasing, given the cards on the table.
function aiTokenNeeds(st, seat, level) {
  const me = st.players[seat];
  const needs = { w: 0, u: 0, g: 0, r: 0, k: 0, p: 0 };
  const cards = [];
  for (const t of [1, 2, 3]) for (const c of st.open[t]) if (c) cards.push(c);
  for (const c of me.reserved) cards.push(c);
  for (const card of cards) {
    const v = Math.min(aiCardScore(st, seat, card, level), 40);
    if (v <= 0) continue;
    const def = {};
    let totDef = 0;
    for (const [c, n] of Object.entries(card.cost)) {
      const disc = c === 'p' ? 0 : (me.bonus[c] || 0);
      def[c] = Math.max(0, n - disc - me.tokens[c]);
      totDef += def[c];
    }
    if (!totDef) continue;
    const w = v / (totDef + 1);
    for (const c in def) if (def[c]) needs[c] += w * Math.min(def[c], 3) * 0.15;
  }
  return needs;
}

// All legal take-lines (1–3 adjacent non-gold tokens in a straight line).
function aiLines(st) {
  const ok = (r, c) => r >= 0 && r < 5 && c >= 0 && c < 5 && st.board[r * 5 + c] && st.board[r * 5 + c] !== 'o';
  const out = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    if (!ok(r, c)) continue;
    out.push([r * 5 + c]);
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      if (!ok(r + dr, c + dc)) continue;
      out.push([r * 5 + c, (r + dr) * 5 + (c + dc)]);
      if (ok(r + 2 * dr, c + 2 * dc)) {
        out.push([r * 5 + c, (r + dr) * 5 + (c + dc), (r + 2 * dr) * 5 + (c + 2 * dc)]);
      }
    }
  }
  return out;
}

function aiCandidates(st, seat, level) {
  const me = st.players[seat], op = st.players[1 - seat];
  const hard = level === 'hard';
  const cands = [];

  // Buy a card (open or reserved).
  for (const t of [1, 2, 3]) st.open[t].forEach((card, idx) => {
    if (!card) return;
    if (card.b === 'x' && !COLORS.some((c) => me.bonus[c] > 0)) return;
    const pay = computePayment(me, card);
    if (!pay) return;
    cands.push({ a: { type: 'buy', kind: 'open', tier: t, idx }, s: aiCardScore(st, seat, card, level) - pay.o * 0.6 });
  });
  me.reserved.forEach((card, idx) => {
    if (card.b === 'x' && !COLORS.some((c) => me.bonus[c] > 0)) return;
    const pay = computePayment(me, card);
    if (!pay) return;
    cands.push({ a: { type: 'buy', kind: 'reserved', idx }, s: aiCardScore(st, seat, card, level) - pay.o * 0.6 + 0.5 });
  });

  // Take tokens.
  const needs = aiTokenNeeds(st, seat, level);
  for (const cells of aiLines(st)) {
    const toks = cells.map((i) => st.board[i]);
    let s = 0;
    for (const t of toks) {
      s += 0.35 + (needs[t] || 0) + (t === 'p' ? 0.4 : 0);
    }
    const pearls = toks.filter((t) => t === 'p').length;
    const sameThree = toks.length === 3 && toks.every((t) => t === toks[0]);
    if ((pearls === 2 || sameThree) && level !== 'easy') s -= 1.2; // gifts the opponent a scroll
    const over = tokenTotal(me) + toks.length - 10;
    if (over > 0) s -= over * 0.6;
    cands.push({ a: { type: 'take', cells }, s });
  }

  // Reserve a face-up card. Mostly a fallback, except blocking an opponent's
  // winning card (hard) — burning turns on reserves loses games.
  if (me.reserved.length < 3 && st.board.includes('o')) {
    for (const t of [1, 2, 3]) st.open[t].forEach((card, idx) => {
      if (!card) return;
      const v = aiCardScore(st, seat, card, level);
      let s = level !== 'easy' && v >= 9 ? Math.min(v * 0.12 + 0.3, 2.2) : 0.15;
      if (hard && aiCardScore(st, 1 - seat, card, level) >= 1000 && computePayment(op, card)) {
        s = 50; // the opponent wins with this card next turn — deny it
      }
      cands.push({ a: { type: 'reserve', kind: 'open', tier: t, idx }, s });
    });
  }

  // Spend a privilege scroll on the most-needed gem (medium/hard only).
  if (level !== 'easy' && me.priv > 0) {
    let best = -1, bs = 0;
    for (let i = 0; i < 25; i++) {
      const t = st.board[i];
      if (!t || t === 'o') continue;
      const v = (needs[t] || 0) + (t === 'p' ? 0.4 : 0);
      if (v > bs) { bs = v; best = i; }
    }
    if (best >= 0) cands.push({ a: { type: 'privilege', cell: best }, s: 0.6 + bs });
  }

  // Replenish — mostly a fallback when there is nothing worth taking.
  if (st.bag.length && st.board.some((t) => t === null)) {
    cands.push({ a: { type: 'replenish' }, s: cands.length ? 0.05 : 1 });
  }

  return cands;
}

function aiResolve(st, seat, level) {
  const p = st.pending[0];
  const me = st.players[seat], op = st.players[1 - seat];
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];

  const R = st.rules || DEFAULT_RULES;
  if (p.type === 'color') {
    const owned = COLORS.filter((c) => me.bonus[c] > 0);
    const val = (c) => (me.cardPts[c] + p.pts >= R.color ? 1000 : 0) + me.cardPts[c] * 0.4 + me.bonus[c] * 0.2;
    const c = level === 'easy' ? rnd(owned) : owned.sort((a, b) => val(b) - val(a))[0];
    return { type: 'resolve', resolve: { type: 'color', color: c } };
  }
  if (p.type === 'steal') {
    const have = COLORS.concat('p').filter((c) => op.tokens[c] > 0);
    if (!have.length) return { type: 'resolve', resolve: { type: 'steal' } }; // fizzles
    let c;
    if (level === 'easy') c = rnd(have);
    else {
      const needs = aiTokenNeeds(st, seat, level);
      const val = (x) => (needs[x] || 0) + (x === 'p' ? 0.5 : 0);
      c = have.sort((a, b) => val(b) - val(a))[0];
    }
    return { type: 'resolve', resolve: { type: 'steal', color: c } };
  }
  if (p.type === 'royal') {
    let idx = 0;
    if (level === 'easy') idx = Math.floor(Math.random() * st.royals.length);
    else {
      let best = -Infinity;
      st.royals.forEach((r, i) => {
        const v = (me.points + r.pts >= R.points ? 1000 : 0) + r.pts * 3 + (r.ab ? AB_SCORE[r.ab] : 0);
        if (v > best) { best = v; idx = i; }
      });
    }
    return { type: 'resolve', resolve: { type: 'royal', idx } };
  }
  if (p.type === 'discard') {
    const d = { w: 0, u: 0, g: 0, r: 0, k: 0, p: 0, o: 0 };
    const have = Object.assign({}, me.tokens);
    const needs = level === 'easy' ? null : aiTokenNeeds(st, seat, level);
    const keepVal = (c) => {
      if (c === 'o') return 5; // gold is precious
      let v = c === 'p' ? 1.2 : 0;
      if (needs) v += needs[c] || 0;
      else v -= have[c] * 0.05; // easy: shed from the biggest pile
      return v;
    };
    let left = p.count;
    while (left > 0) {
      const order = Object.keys(have).filter((c) => have[c] > 0).sort((a, b) => keepVal(a) - keepVal(b));
      have[order[0]]--; d[order[0]]++; left--;
    }
    return { type: 'resolve', resolve: { type: 'discard', tokens: d } };
  }
  return null;
}

function aiAction(st, seat, level) {
  if (st.phase !== 'playing' || st.turn !== seat) return null;
  if (st.pending.length) return aiResolve(st, seat, level);
  const cands = aiCandidates(st, seat, level);
  if (!cands.length) return st.bag.length ? { type: 'replenish' } : null;
  if (level === 'easy') {
    const win = cands.find((c) => c.s >= 1000);
    if (win && Math.random() < 0.5) return win.a; // easy still wins sometimes
    const buys = cands.filter((c) => c.a.type === 'buy');
    if (buys.length && Math.random() < 0.6) return buys[Math.floor(Math.random() * buys.length)].a;
    const pool = cands.filter((c) => c.a.type === 'buy' || c.a.type === 'take');
    const from = pool.length ? pool : cands;
    return from[Math.floor(Math.random() * from.length)].a;
  }
  // Medium plays the same greedy strategy as hard but with noisy judgement;
  // winning moves (>=1000) stay dominant even after the noise.
  if (level === 'medium') for (const c of cands) c.s *= 0.5 + Math.random();
  cands.sort((a, b) => b.s - a.s);
  return cands[0].a;
}

// ---------------------------------------------------------------------------

globalThis.SplendorEngine = {
  COLORS, TOKEN_SUPPLY, GEM_NAMES, DEFAULT_RULES,
  newGame, applyAction, publicState, lineOK, computePayment, tokenTotal,
  aiAction,
};
})();
