/**
 * Identity gate before a number purchase or a call: email OTP + phone OTP.
 * A card is not collected at signup. The number is a separate 30-day payment, and
 * calling credit is a separate wallet top-up. ID and/or address still apply when
 * the DID country requires them.
 */
export type KycCheckType = 'email' | 'phone' | 'payment_method' | 'id_document' | 'address';
export type KycStatus = 'pending' | 'passed' | 'failed';

export interface KycCheck {
  checkType: KycCheckType;
  status: KycStatus;
  country?: string | null;
  createdAt: Date;
}

export interface CountryRequirement {
  country: string;
  requiresId: boolean;
  requiresAddress: boolean;
  addressMustBeLocal: boolean;
}

export type KycAction = 'place_call' | 'buy_did' | 'receive_call';

export interface KycDecision {
  allowed: boolean;
  missing: KycCheckType[];
  failed: KycCheckType[];
}

export const BASE_REQUIREMENTS: readonly KycCheckType[] = ['email', 'phone'];

/** Latest check per type wins (a later 'failed' revokes an earlier 'passed'). */
export function latestByType(checks: readonly KycCheck[]): Map<KycCheckType, KycCheck> {
  const m = new Map<KycCheckType, KycCheck>();
  for (const c of checks) {
    const cur = m.get(c.checkType);
    if (!cur || c.createdAt.getTime() > cur.createdAt.getTime()) m.set(c.checkType, c);
  }
  return m;
}

export function evaluateKyc(
  checks: readonly KycCheck[],
  action: KycAction,
  didCountryReq?: CountryRequirement | null,
): KycDecision {
  const required: KycCheckType[] = [...BASE_REQUIREMENTS];
  if (action === 'buy_did' && didCountryReq) {
    if (didCountryReq.requiresId) required.push('id_document');
    if (didCountryReq.requiresAddress) required.push('address');
  }
  const latest = latestByType(checks);
  const missing: KycCheckType[] = [];
  const failed: KycCheckType[] = [];
  for (const t of required) {
    const c = latest.get(t);
    if (!c || c.status === 'pending') {
      missing.push(t);
      continue;
    }
    if (c.status === 'failed') {
      failed.push(t);
      continue;
    }
    if (t === 'address' && didCountryReq?.addressMustBeLocal && c.country && c.country !== didCountryReq.country) {
      failed.push(t);
    }
  }
  return { allowed: missing.length === 0 && failed.length === 0, missing, failed };
}
