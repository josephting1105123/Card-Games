/**
 * Driving a table: letting bots take their turn, and running whole games
 * head-to-head for tuning and for the tests.
 *
 * Kept separate from the engine so the engine stays a pure state machine, and
 * separate from the UI so a match can be run a thousand times in a terminal.
 */

import { makeRng } from '../../core/rng.js';
import { Phase, bid, createGame, pass, play, seatView } from './engine.js';
import { chooseBid, chooseMove, skillByName } from './ai.js';

/**
 * Whose turn it is, and whether that seat is a bot.
 * @returns {{seat: number, kind: 'bid'|'play'}|null}
 */
export function actorOnTurn(state) {
  if (state.phase === Phase.BIDDING) return { seat: state.bidding.turn, kind: 'bid' };
  if (state.phase === Phase.PLAYING) return { seat: state.turn, kind: 'play' };
  return null;
}

/**
 * Take one bot action for the seat on turn. Returns what it did, or null when it
 * is not a bot's turn.
 */
export function botTurn(state, rng) {
  const actor = actorOnTurn(state);
  if (!actor) return null;
  const player = state.players[actor.seat];
  if (!player.isBot) return null;
  const skill = skillByName(player.skill?.name?.toLowerCase?.() ?? player.skillId ?? 'steady');
  const profile = player.skill ?? skill;
  const view = seatView(state, actor.seat);

  if (actor.kind === 'bid') {
    const value = chooseBid(view, profile, rng);
    const res = bid(state, actor.seat, value);
    return { kind: 'bid', seat: actor.seat, value, res };
  }
  const move = chooseMove(view, profile, rng);
  if (!move || move.pass) {
    const res = pass(state, actor.seat);
    return { kind: 'pass', seat: actor.seat, res };
  }
  const res = play(state, actor.seat, move.cards);
  if (!res.ok) {
    // A bot must never produce an illegal move; if the evaluation somehow does,
    // fall back to passing rather than wedging the table.
    const fallback = state.trick ? pass(state, actor.seat) : play(state, actor.seat, [state.players[actor.seat].hand[0]]);
    return { kind: 'fallback', seat: actor.seat, error: res.error, res: fallback };
  }
  return { kind: 'play', seat: actor.seat, cards: move.cards, res };
}

/**
 * Play a whole game with a bot in every seat.
 * @param {object} args
 * @param {string|number} args.seed
 * @param {string[]} args.skills three skill profile names, one per seat
 * @param {number} [args.maxSteps] safety valve against a stuck table
 */
export function simulateGame({ seed, skills, maxSteps = 4_000 }) {
  const state = createGame({
    seed,
    players: skills.map((name, seat) => ({
      id: `bot${seat}`,
      name: `${skillByName(name).name} ${seat}`,
      isBot: true,
      skill: skillByName(name),
    })),
  });
  const rng = makeRng(`${seed}:play`);
  let steps = 0;
  while (state.phase !== Phase.FINISHED) {
    if (++steps > maxSteps) throw new Error('simulateGame: table did not finish');
    const acted = botTurn(state, rng);
    if (!acted) throw new Error('simulateGame: no bot on turn');
  }
  return { state, result: state.result, steps };
}

/**
 * Head-to-head record. One skill takes the landlord's seat whenever it wins the
 * bidding, so this measures overall chip flow rather than role win rate.
 *
 * @returns {{games: number, byLobby: object, wins: number[], chips: number[]}}
 */
export function runSeries({ games = 100, skills, seedPrefix = 'series' }) {
  const wins = [0, 0, 0];
  const chips = [0, 0, 0];
  for (let i = 0; i < games; i++) {
    const { result } = simulateGame({ seed: `${seedPrefix}:${i}`, skills });
    const landlord = result.landlordSeat;
    for (let seat = 0; seat < 3; seat++) {
      const isLandlord = seat === landlord;
      const won = isLandlord === result.landlordWon;
      if (won) wins[seat] += 1;
      const magnitude = (isLandlord ? 2 : 1) * result.multiplier;
      chips[seat] += won ? magnitude : -magnitude;
    }
  }
  return { games, wins, chips };
}
