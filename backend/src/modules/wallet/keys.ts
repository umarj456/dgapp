/** Prefix checks only. Never log or store the rest of a key. */

const SECRET = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;
const PUBLISHABLE = /^pk_(test|live)_[A-Za-z0-9]+$/;

export function isPlaceholder(value: string | undefined): boolean {
  return !value || value.includes('placeholder');
}

/** Secret or restricted key. rk_live_ is a restricted live key and is valid. */
export function isStripeSecretKey(key: string | undefined): boolean {
  return !!key && !isPlaceholder(key) && SECRET.test(key);
}

export function isLiveStripeSecret(key: string | undefined): boolean {
  return !!key && /^rk_live_|^sk_live_/.test(key);
}

export function isStripePublishableKey(key: string | undefined): boolean {
  return !!key && !isPlaceholder(key) && PUBLISHABLE.test(key);
}
