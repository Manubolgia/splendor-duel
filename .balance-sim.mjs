// Throwaway balance simulator. Plays full AI-vs-AI games under different
// win-condition thresholds and reports the win-reason distribution, so we can
// pick a "MNBG" ruleset where points / crowns / color wins are closer to equal.
//
// Usage: node .balance-sim.mjs [gamesPerConfig] [aiLevel]
// It monkeypatches checkWin via a rules object once the engine supports it,
// but to keep this script independent of engine internals we re-implement the
// win check here and run the engine to near-completion, deciding the winner
// ourselves under each candidate ruleset from a single shared playthrough.

import './engine.js';
const E = globalThis.SplendorEngine;
const { newGame, applyAction, aiAction } = E;
const COLORS = ['w', 'u', 'g', 'r', 'k'];

const GAMES = parseInt(process.argv[2] || '400', 10);
const LEVEL = process.argv[3] || 'hard';

// A ruleset: thresholds for each win path. Lower a threshold => that path
// becomes easier => it should fire more often.
function reasonUnder(p, rules) {
  // Returns which win conditions this player currently satisfies (a set).
  const out = [];
  if (p.points >= rules.points) out.push('points');
  if (p.crowns >= rules.crowns) out.push('crowns');
  for (const c of COLORS) if (p.cardPts[c] >= rules.color) { out.push('color'); break; }
  return out;
}

// Run ONE game under a given "driving" ruleset (the thresholds the engine uses
// to actually end the game). We then record, at the moment of victory, which
// of several *candidate* rulesets would also have ended it and via what reason.
// Simpler & more honest: just play each config as its own real game.

// Patch the engine's checkWin through newGame's rules support.
function playGame(rules, seed) {
  const st = newGame(['A', 'B'], seed & 1, rules);
  let steps = 0;
  while (st.phase === 'playing' && steps < 4000) {
    const a = aiAction(st, st.turn, LEVEL);
    if (!a) {
      // No move (shouldn't happen); force replenish or bail.
      if (st.bag.length && st.board.some((t) => t === null)) {
        applyAction(st, st.turn, { type: 'replenish' });
      } else break;
    } else {
      const err = applyAction(st, st.turn, a);
      if (err) break;
    }
    steps++;
  }
  return st;
}

function sweep(configs) {
  console.log(`\n${GAMES} games/config, AI=${LEVEL}\n`);
  console.log('points crowns color |  pts%  crown%  color%  unfinished% | avgTurns');
  console.log('-'.repeat(78));
  for (const rules of configs) {
    const tally = { points: 0, crowns: 0, color: 0, none: 0 };
    let turnSum = 0, finished = 0;
    for (let g = 0; g < GAMES; g++) {
      const st = playGame(rules, g);
      if (st.phase === 'over') {
        tally[st.winReason]++;
        turnSum += st.turnNo;
        finished++;
      } else {
        tally.none++;
      }
    }
    const pct = (n) => ((n / GAMES) * 100).toFixed(1).padStart(5);
    const avg = finished ? (turnSum / finished).toFixed(1) : '—';
    console.log(
      `${String(rules.points).padStart(6)} ${String(rules.crowns).padStart(6)} ${String(rules.color).padStart(5)} |` +
      ` ${pct(tally.points)} ${pct(tally.crowns)} ${pct(tally.color)} ${pct(tally.none)}        | ${avg}`
    );
  }
}

// Baseline (official) + candidate rulesets that lower crowns/color thresholds
// and/or raise the points threshold to spread out the win paths.
const configs = [
  { points: 20, crowns: 10, color: 10 }, // official baseline
  { points: 22, crowns: 7, color: 9 },
  { points: 22, crowns: 7, color: 9 },
  { points: 21, crowns: 7, color: 9 },
];
sweep(configs);
