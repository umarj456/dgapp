/**
 * Thin wrapper around SIP.js SimpleUser: registers over WSS to the DG edge, places and receives calls.
 * Credentials are per-device and issued by the API (/v1/sip/credentials).
 */
import { Web } from 'sip.js';
import type { SipCredential } from './api';

export type CallState = 'idle' | 'registering' | 'ready' | 'calling' | 'ringing' | 'in_call' | 'error';

export interface PhoneEvents {
  onState(s: CallState, detail?: string): void;
  onIncoming(from: string): void;
}

export class Phone {
  private user: Web.SimpleUser | null = null;
  constructor(private cred: SipCredential, private ev: PhoneEvents) {}

  async start() {
    this.ev.onState('registering');
    const audio = document.getElementById('remoteAudio') as HTMLAudioElement;
    this.user = new Web.SimpleUser(this.cred.wssUrl, {
      aor: `sip:${this.cred.aor}@${this.cred.realm}`,
      media: { constraints: { audio: true, video: false }, remote: { audio } },
      userAgentOptions: {
        authorizationUsername: this.cred.authUsername,
        authorizationPassword: this.cred.password,
        displayName: this.cred.aor,
      },
      delegate: {
        onCallReceived: () => {
          const from = (this.user as any)?.session?.remoteIdentity?.uri?.user ?? 'unknown';
          this.ev.onState('ringing');
          this.ev.onIncoming(from);
        },
        onCallAnswered: () => this.ev.onState('in_call'),
        onCallHangup: () => this.ev.onState('ready'),
        onServerDisconnect: (e?: Error) => this.ev.onState('error', e?.message ?? 'disconnected'),
      },
    });
    await this.user.connect();
    await this.user.register();
    this.ev.onState('ready');
  }

  async call(number: string) {
    if (!this.user) throw new Error('not started');
    const digits = number.replace(/[^\d+]/g, '').replace(/^\+/, '');
    this.ev.onState('calling');
    try {
      await this.user.call(`sip:${digits}@${this.cred.realm}`, undefined, {
        requestDelegate: {
          onReject: (r) => this.ev.onState('ready', `${r.message.statusCode} ${r.message.reasonPhrase}`),
        },
      });
    } catch (e) {
      this.ev.onState('ready', (e as Error).message);
    }
  }

  answer() { return this.user?.answer(); }
  decline() { return this.user?.decline(); }
  hangup() { return this.user?.hangup(); }
  dtmf(d: string) { return this.user?.sendDTMF(d); }
  async stop() { await this.user?.unregister().catch(() => {}); await this.user?.disconnect(); }
}
