/**
 * Driving a table: letting a bot take its turn, and running whole hands and
 * sessions with a bot in every seat for tuning and for the tests.
 *
 * Kept apart from the engine so the engine stays a pure state machine, and
 * apart from the UI so a hand can be replayed a thousand times in a terminal.
 */

import { makeRng } from '../../core/rng.js';
import { Phase, act, createHand, legalActions, nextButton, seatView } from './engine.js';
import { SKILLS, chooseAction, skillByName } from './ai.js';

/**
 * Take one bot action for the seat on turn. Returns null when the hand is over
 * or the seat on turn is a human's.
 * @param {object} state
 * @param {() => number} rng
 * @returns {{seat: number, action: object, res: object, fallback?: string} | null}
 */
export function botTurn(state, rng) {
  if (state.phase === Phase.FINISHED) return null;
  const seat = state.turn;
  const player = state.players[seat];
  if (!player || player.isHuman) return null;

  const skill = player.skill ?? SKILLS.steady;
  const action = chooseAction(seatView(state, seat), skill, rng);
  const res = act(state, seat, action);
  if (res.ok) return { seat, action, res };

  // A bot must never wedge the table: check if it can, otherwise fold.
  const legal = legalActions(state, seat);
  const safe = legal?.canCheck ? { type: 'check' } : { type: 'fold' };
  return { seat, action: safe, res: act(state, seat, safe), fallback: res.error };
}

const asSkill = (s) => (typeof s === 'string' ? skillByName(s) : s ?? SKILLS.steady);

/**
 * Play one hand with a bot in every seat.
 * @param {object} args
 * @param {string|number} args.seed
 * @param {number[]} args.stacks chips per seat
 * @param {(string|object)[]} args.skills skill names or profiles, one per seat
 * @returns {{state: object, steps: number, fallbacks: number}}
 */
export function simulateHand({ seed, stacks, skills, button = 0, smallBlind = 10, bigBlind = 20, maxSteps = 1000 }) {
  const players = stacks.map((stack, i) => ({
    name: `Bot ${i + 1}`,
    isBot: true,
    skill: asSkill(skills?.[i]),
    stack,
  }));
  const dealer = players[button]?.stack > 0 ? button : nextButton(players, button);
  const state = createHand({ seed, players, button: dealer, smallBlind, bigBlind });
  const rng = makeRng(`${seed}:bots`);

  let steps = 0;
  let fallbacks = 0;
  while (state.phase !== Phase.FINISHED) {
    if (steps >= maxSteps) throw new Error(`hand ${seed} did not finish in ${maxSteps} steps`);
    const turn = botTurn(state, rng);
    if (!turn) throw new Error(`hand ${seed} stalled with nobody to act in ${state.phase}`);
    if (turn.fallback) fallbacks++;
    steps++;
  }
  return { state, steps, fallbacks };
}

/**
 * Play successive hands, carrying stacks, rotating the button and re-buying
 * busted seats to `startStack`.
 * @returns {{stacks: number[], net: number[], rebuys: number[], hands: number}}
 */
export function runSession({ hands, seedPrefix = 'session', skills, startStack = 2000, smallBlind = 10, bigBlind = 20 }) {
  const n = skills.length;
  let stacks = new Array(n).fill(startStack);
  const rebuys = new Array(n).fill(0);
  let button = -1;

  for (let h = 0; h < hands; h++) {
    for (let s = 0; s < n; s++) {
      if (stacks[s] <= 0) {
        stacks[s] = startStack;
        rebuys[s]++;
      }
    }
    button = nextButton(stacks.map((stack) => ({ stack })), button);
    const { state } = simulateHand({ seed: `${seedPrefix}-${h}`, stacks, skills, button, smallBlind, bigBlind });
    stacks = state.players.map((p) => p.stack);
  }

  // Net of the chips each seat has bought in, so a re-buy isn't counted as a win.
  const net = stacks.map((stack, s) => stack - startStack * (1 + rebuys[s]));
  return { stacks, net, rebuys, hands };
}
