/**
 * The games this app knows about. Only Dou Di Zhu is playable so far; the rest
 * are listed so the menu shows what is coming and in what order.
 *
 * `status` is one of 'ready' | 'planned'. A planned game keeps its tile in the
 * menu but the tile does not open a table.
 */

export const GAMES = [
  {
    id: 'doudizhu',
    name: 'Dou Di Zhu',
    nameZh: '斗地主',
    tagline: 'Fight the Landlord',
    players: 3,
    status: 'ready',
    accent: '#c8362f',
    description:
      'Two farmers against one landlord over 54 cards. Call points to take the landlord’s seat and the three face-down cards, then be first to empty your hand. Bombs double the stake.',
    ruleNotes: [
      '3 < 4 < … < K < A < 2 < small joker < big joker',
      'Chains may not pass the ace; 2s and jokers never join a chain',
      'Bid 1–3 points; a call of 3 ends the bidding at once',
      'Each bomb or rocket doubles the stake, as does a spring',
    ],
  },
  {
    id: 'big2',
    name: 'Big Two',
    nameZh: '锄大地',
    tagline: 'Deuces / Choi Dai Di',
    players: 4,
    status: 'planned',
    accent: '#2f6fc8',
    description: 'Four players, 13 cards each, suits rank. Poker hands beat poker hands. Next in the queue.',
  },
  {
    id: 'blackjack',
    name: 'Blackjack',
    tagline: 'American and Malaysian',
    players: 1,
    status: 'planned',
    accent: '#1f7a4d',
    description: 'Two rule sets in one table: the American game, and the Malaysian house game with its own payouts and five-card rules.',
  },
  {
    id: 'niu',
    name: 'Niu Niu',
    nameZh: '牛牛',
    tagline: 'Bull / Nine-Nine',
    players: 5,
    status: 'planned',
    accent: '#a9701f',
    description: 'Five cards, split three and two, chase the bull. Fast betting rounds against the banker.',
  },
  {
    id: 'texas',
    name: "Texas Hold’em",
    tagline: 'No-limit poker',
    players: 6,
    status: 'planned',
    accent: '#5b3fa8',
    description: 'Two hole cards, five on the board, no-limit betting against the table.',
  },
];

export function gameById(id) {
  return GAMES.find((g) => g.id === id) ?? null;
}

export const READY_GAMES = GAMES.filter((g) => g.status === 'ready');
