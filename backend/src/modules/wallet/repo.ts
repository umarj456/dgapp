import type { Db } from '../../db.js';
import { HttpError } from '../../lib/errors.js';

export type LedgerKind = 'topup' | 'call' | 'did_subscription' | 'did_setup' | 'refund' | 'adjustment';

export interface WalletRow { balanceMicros: number; heldMicros: number; currency: string }

/** Lock and read the wallet row. Call inside a transaction. */
export async function lockWallet(db: Db, userId: string): Promise<WalletRow> {
  const r = await db.query(`SELECT balance_micros, held_micros, currency FROM wallets WHERE user_id=$1 FOR UPDATE`, [userId]);
  if (!r.rowCount) throw new HttpError(404, 'wallet_not_found');
  return { balanceMicros: r.rows[0].balance_micros, heldMicros: r.rows[0].held_micros, currency: r.rows[0].currency };
}

export async function getWallet(db: Db, userId: string): Promise<WalletRow | null> {
  const r = await db.query(`SELECT balance_micros, held_micros, currency FROM wallets WHERE user_id=$1`, [userId]);
  return r.rowCount ? { balanceMicros: r.rows[0].balance_micros, heldMicros: r.rows[0].held_micros, currency: r.rows[0].currency } : null;
}

/**
 * Post a ledger entry and move the balance. Positive = credit, negative = debit.
 * Debits may only use AVAILABLE money (balance - held): prepaid only, never negative.
 * Idempotent when `idempotencyKey` is given (returns false if already applied).
 */
export async function postLedger(
  db: Db,
  userId: string,
  kind: LedgerKind,
  amountMicros: number,
  opts: { idempotencyKey?: string; refType?: string; refId?: string; memo?: string; releaseHeldMicros?: number } = {},
): Promise<boolean> {
  if (opts.idempotencyKey) {
    const dup = await db.query(`SELECT 1 FROM ledger_entries WHERE idempotency_key=$1`, [opts.idempotencyKey]);
    if (dup.rowCount) return false;
  }
  const w = await lockWallet(db, userId);
  const release = opts.releaseHeldMicros ?? 0;
  const newHeld = w.heldMicros - release;
  const newBalance = w.balanceMicros + amountMicros;
  if (newHeld < 0) throw new Error('held would go negative');
  if (amountMicros < 0 && newBalance < newHeld) throw new HttpError(402, 'insufficient_balance');
  await db.query(`UPDATE wallets SET balance_micros=$2, held_micros=$3, updated_at=now() WHERE user_id=$1`, [userId, newBalance, newHeld]);
  if (amountMicros !== 0) {
    await db.query(
      `INSERT INTO ledger_entries (user_id, kind, amount_micros, balance_after, ref_type, ref_id, idempotency_key, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, kind, amountMicros, newBalance, opts.refType ?? null, opts.refId ?? null, opts.idempotencyKey ?? null, opts.memo ?? null],
    );
  }
  return true;
}

export async function addHold(db: Db, userId: string, micros: number): Promise<void> {
  const r = await db.query(
    `UPDATE wallets SET held_micros = held_micros + $2, updated_at=now()
      WHERE user_id=$1 AND balance_micros - held_micros >= $2`,
    [userId, micros],
  );
  if (!r.rowCount) throw new HttpError(402, 'insufficient_balance');
}

export const microsToUsd = (m: number) => (m / 1_000_000).toFixed(4);
export const usdToMicros = (usd: number) => Math.round(usd * 1_000_000);
