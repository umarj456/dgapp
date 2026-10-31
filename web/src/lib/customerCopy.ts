import type { CallState } from './phone';

/** Customer-facing call line. Engineering detail stays in the console. */
export function customerCallStatus(state: CallState): string {
  switch (state) {
    case 'idle':
    case 'registering':
      return 'Connecting';
    case 'ready':
      return 'Ready';
    case 'calling':
      return 'Calling';
    case 'ringing':
      return 'Incoming call';
    case 'in_call':
      return 'On call';
    default:
      return "Can't connect";
  }
}

export function customerCallHint(state: CallState, raw?: string): string {
  if (raw) console.warn('[dg call]', state, raw);
  if (state === 'error') return '';
  const code = Number((raw ?? '').match(/^\d{3}/)?.[0]);
  if (code === 402 || /balance|top up|insufficient/i.test(raw ?? '')) return 'Not enough balance';
  if (raw) return "Call didn't go through";
  return '';
}

export function dollars(value?: string | number | null): string {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

export function friendlyFailure(error: unknown): string {
  console.error(error);
  const body = (error as { body?: { error?: string; missing?: string[] } })?.body;
  if (body?.error === 'kyc_required' && body.missing?.includes('phone')) return 'Confirm your phone, then try again.';
  if (body?.error === 'insufficient_balance') return 'Not enough calling credit.';
  return "That didn't go through. Try again.";
}
