/** Normalise a dialled number to E.164 digits (no '+'). Accepts +E164, 00-international, or NANP 10-digit. */
export function normalizeDialed(input: string, defaultCountryCode = '1'): string | null {
  let s = input.replace(/[\s().-]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('011')) s = s.slice(3);
  else if (defaultCountryCode === '1' && /^[2-9]\d{9}$/.test(s)) s = '1' + s;
  if (!/^\d{7,15}$/.test(s)) return null;
  return s;
}

export const isE164Digits = (s: string) => /^[1-9]\d{6,14}$/.test(s);
