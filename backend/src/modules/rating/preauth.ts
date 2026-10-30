/**
 * Prepaid pre-authorization and settlement (pure). The DB layer applies the returned deltas atomically.
 *   available = balance - held
 * authorize -> hold `reserve` on the wallet for the max duration the balance allows.
 * settle    -> release the hold, debit the actual cost (never more than reserved).
 */
import { Rate, callCost, maxDurationForBalance } from './rating.js';

export interface WalletState { balanceMicros: number; heldMicros: number }

export interface PreauthPolicy {
  maxCallSeconds: number;   // absolute cap per call (e.g. 4h)
  minCallSeconds: number;   // refuse calls the user cannot afford for at least this long
  perCallReserveCapMicros?: number; // optional ceiling on a single hold (e.g. new-account limit)
}

export type PreauthResult =
  | { ok: true; maxDurationSec: number; reserveMicros: number }
  | { ok: false; reason: 'insufficient_balance' | 'no_rate' };

export function availableMicros(w: WalletState): number {
  return Math.max(0, w.balanceMicros - w.heldMicros);
}

export function preauthorize(wallet: WalletState, rate: Rate | null, policy: PreauthPolicy): PreauthResult {
  if (!rate) return { ok: false, reason: 'no_rate' };
  let budget = availableMicros(wallet);
  if (policy.perCallReserveCapMicros !== undefined) budget = Math.min(budget, policy.perCallReserveCapMicros);
  if (budget <= 0) return { ok: false, reason: 'insufficient_balance' };

  const maxDurationSec = maxDurationForBalance(budget, rate, policy.maxCallSeconds);
  if (maxDurationSec <= 0 || maxDurationSec < Math.min(policy.minCallSeconds, policy.maxCallSeconds)) {
    return { ok: false, reason: 'insufficient_balance' };
  }
  const reserveMicros = callCost(maxDurationSec, rate);
  return { ok: true, maxDurationSec, reserveMicros };
}

export interface SettleResult {
  chargeMicros: number;      // amount debited from balance
  releaseMicros: number;     // amount removed from held (always the full reservation)
  overrunMicros: number;     // cost above the reservation that we could NOT charge (edge failed to cut the call)
  billedSec: number;
}

export function settle(reservedMicros: number, billsec: number, rate: Rate): SettleResult {
  const fullCost = callCost(billsec, rate);
  const chargeMicros = Math.min(fullCost, reservedMicros);
  return {
    chargeMicros,
    releaseMicros: reservedMicros,
    overrunMicros: fullCost - chargeMicros,
    billedSec: billsec,
  };
}

/** Apply a settle result to a wallet snapshot (used by tests and as a sanity check in the DB layer). */
export function applySettle(w: WalletState, s: SettleResult): WalletState {
  return { balanceMicros: w.balanceMicros - s.chargeMicros, heldMicros: w.heldMicros - s.releaseMicros };
}
