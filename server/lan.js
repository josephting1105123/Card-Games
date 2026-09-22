/** Working out which address to tell the other players to type. */

import { networkInterfaces } from 'node:os';

/**
 * Private IPv4 addresses on this machine, most likely first. Link-local (169.254)
 * and loopback are skipped; 192.168 is listed before 10.x because a home router
 * hands those out and that is where this feature gets used.
 */
export function lanAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      out.push({ name, address: entry.address, rank: rankAddress(entry.address) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function rankAddress(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

export function primaryAddress() {
  return lanAddresses()[0]?.address ?? null;
}
