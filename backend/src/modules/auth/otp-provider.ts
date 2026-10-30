/** OTP delivery is behind an interface so the real provider (SMTP/SES, Twilio/Vonage/SIPNAV SMS ...) is a drop-in. */
export interface OtpProvider {
  readonly name: string;
  send(channel: 'email' | 'sms', destination: string, code: string, purpose: string): Promise<void>;
}

/** DEV ONLY: logs codes to the server console. Refused in production by config.ts. */
export class ConsoleOtpProvider implements OtpProvider {
  readonly name = 'console';
  public last = new Map<string, string>();
  async send(channel: 'email' | 'sms', destination: string, code: string, purpose: string) {
    this.last.set(destination, code);
    // eslint-disable-next-line no-console
    console.log(`[otp:${channel}] ${purpose} code for ${destination}: ${code}`);
  }
}

/** Placeholder for the real providers; wire credentials from env when Umar picks a vendor. */
export class NotConfiguredOtpProvider implements OtpProvider {
  constructor(readonly name: string) {}
  async send(): Promise<void> {
    throw new Error(`OTP provider '${this.name}' is not implemented yet`);
  }
}

export function makeOtpProvider(kind: string): OtpProvider {
  return kind === 'console' ? new ConsoleOtpProvider() : new NotConfiguredOtpProvider(kind);
}
