const BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  constructor(public status: number, public body: any) { super(body?.error ?? `HTTP ${status}`); }
}

let token = localStorage.getItem('dg_token') ?? '';
export const setToken = (t: string) => { token = t; t ? localStorage.setItem('dg_token', t) : localStorage.removeItem('dg_token'); };
export const hasToken = () => !!token;

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export interface Me {
  id: string; email: string; sipAor: string;
  kyc: { checks: Record<string, string>; canCall: boolean; missing: string[]; failed: string[] };
  wallet: { balanceUsd: string; availableUsd: string; currency: string } | null;
  numbers: { assignment_id: string; e164: string; country: string; region: string; status: string; auto_renew: boolean; current_period_end: string | null; is_primary_cid: boolean }[];
}

export interface AvailableDid {
  id: string; e164: string; country: string; region: string; number_type: string; monthly_price_usd: string; setup_price_usd: string;
}

export interface SipCredential { authUsername: string; password: string; aor: string; realm: string; wssUrl: string }
