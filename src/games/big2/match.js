/**
 * Driving a table: letting a bot take its turn, and running whole hands
 * head-to-head for tuning and for the tests.
 *
 * Kept separate from the engine so the engine stays a pure state machine, and
 * separate from the UI so a hand can be replayed a thousand times in a
 * terminal — same split as doudizhu/match.js.
 */

import { makeRng } from '../../core/rng.js';
import { Phase, createGame, pass, play, seatView } from './engine.js';
import { SKILLS, chooseMove } from './ai.js';

/**
 * Take one bot action for the seat on turn. Returns what it did, or null when
 * it is not a bot's turn (the human's, or the hand has already finished).
 * @param {object} state
 * @param {() => number} rng
 */
export function botTurn(state, rng) {
  if (state.phase !== Phase.PLAYING) return null;
  const seat = state.turn;
  const player = state.players[seat];
  if (player.isHuman) return null;
  const skill = player.skill ?? SKILLS.steady;
  const view = seatView(state, seat);
  const move = chooseMove(view, skill, rng);

  if (move.action === 'pass') {
    const res = pass(state, seat);
    if (res.ok) return { kind: 'pass', seat, res };
    // A bot must never produce an illegal action; if the evaluation somehow
    // does (passing while on lead), fall back to its lowest single rather
    // than wedging the table.
    const fallback = play(state, seat, [state.hands[seat][0]]);
    return { kind: 'fallback', seat, error: res.error, res: fallback };
  }
  const res = play(state, seat, move.cards);
  if (res.ok) return { kind: 'play', seat, cards: move.cards, res };
  const fallback = state.trick ? pass(state, seat) : play(state, seat, [state.hands[seat][0]]);
  return { kind: 'fallback', seat, error: res.error, res: fallback };
}

/**
 * Play a whole hand with a bot in every seat.
 * @param {object} args
 * @param {string|number} args.seed
 * @param {string[]} args.skills four skill profile names, one per seat
 * @param {number} [args.maxSteps] safety valve against a stuck table
 * @returns {{winner: number, cardsLeft: number[], steps: number}}
 */
export function simulateGame({ seed, skills, maxSteps = 4_000 }) {
  const state = createGame({
    seed,
    players: skills.map((name, seat) => {
      const skill = SKILLS[name] ?? SKILLS.steady;
      return { name: `${skill.name} ${seat}`, isHuman: false, skill };
    }),
  });
  const rng = makeRng(`${seed}:play`);
  let steps = 0;
  const actions = [];
  while (state.phase !== Phase.FINISHED) {
    if (++steps > maxSteps) throw new Error('simulateGame: table did not finish');
    const acted = botTurn(state, rng);
    if (!acted) throw new Error('simulateGame: no bot on turn');
    actions.push(acted);
  }
  return { winner: state.winner, cardsLeft: state.hands.map((h) => h.length), steps, actions };
}

/**
 * Head-to-head record: how many hands each seat wins.
 * @returns {{games: number, wins: number[]}}
 */
export function runSeries({ games = 100, skills, seedPrefix = 'series' }) {
  const wins = [0, 0, 0, 0];
  for (let i = 0; i < games; i++) {
    const { winner } = simulateGame({ seed: `${seedPrefix}:${i}`, skills });
    wins[winner] += 1;
  }
  return { games, wins };
}
