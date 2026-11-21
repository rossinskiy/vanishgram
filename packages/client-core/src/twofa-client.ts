// Two-step verification on the client: TOTP enrollment and the cloud password.
// The cloud password uses OPAQUE (an augmented PAKE): the server never receives the password or any value that can be
// checked against a guess offline. Argon2id key stretching runs on this device inside the OPAQUE exchange.
import * as opaque from '@serenity-kit/opaque';
import { OPAQUE_KEY_STRETCHING, OPAQUE_SERVER_ID } from '@vanishgram/protocol';
import type { VanishClient } from './client.ts';

export const MIN_PASSWORD_LENGTH = 10;

export interface SecondFactorRequest { totp: boolean; password: boolean; attempt: number }
export interface SecondFactorAnswer { totp?: string; recovery?: string; password?: string }
/** Return the user's input, or null to cancel the sign-in. */
export type SecondFactorHook = (req: SecondFactorRequest) => Promise<SecondFactorAnswer | null>;

const norm = (p: string) => p.normalize('NFKC');
const ids = (accountId: string) => ({ client: accountId, server: OPAQUE_SERVER_ID });
const verifyFailed = () => Object.assign(new Error('verification failed'), { status: 401 });

/** Run the client half of an OPAQUE login against `startPath`. Returns null when the password is wrong (detected on this device). */
export async function opaqueLogin(c: VanishClient, startPath: string, extra: Record<string, unknown>, password: string): Promise<{ loginId: string; finish: string } | null> {
  await opaque.ready;
  const pw = norm(password);
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: pw });
  const r = await c.http<{ loginId: string; response: string }>('POST', startPath, { ...extra, request: startLoginRequest });
  const fin = opaque.client.finishLogin({ clientLoginState, loginResponse: r.response, password: pw, identifiers: ids(c.account.accountId), keyStretching: OPAQUE_KEY_STRETCHING });
  return fin ? { loginId: r.loginId, finish: fin.finishLoginRequest } : null;
}

export interface TwoFactorStatus { totp: boolean; password: boolean; recoveryCodesLeft: number }

export class TwoFactorManager {
  c: VanishClient;
  constructor(c: VanishClient) { this.c = c; }
  status() { return this.c.http<TwoFactorStatus>('GET', '/v1/2fa'); }

  setupTotp() { return this.c.http<{ secret: string; uri: string }>('POST', '/v1/2fa/totp/setup'); }
  /** Returns one-time recovery codes: the only way in if the authenticator is lost. */
  async enableTotp(code: string): Promise<string[]> { return (await this.c.http<{ recoveryCodes: string[] }>('POST', '/v1/2fa/totp/enable', { code })).recoveryCodes; }
  async disableTotp(factor: { code?: string; recovery?: string }) { await this.c.http('POST', '/v1/2fa/totp/disable', { totp: factor.code, recovery: factor.recovery }); }
  async regenerateRecovery(code: string): Promise<string[]> { return (await this.c.http<{ recoveryCodes: string[] }>('POST', '/v1/2fa/recovery/regenerate', { code })).recoveryCodes; }

  /** Prove the current password to the server (needed to change or remove it). */
  private async prove(current: string) {
    const v = await opaqueLogin(this.c, '/v1/2fa/password/verify/start', {}, current);
    if (!v) throw verifyFailed();
    return v;
  }

  /** Set or change the cloud password. `current` is required when one already exists. */
  async setPassword(password: string, current?: string) {
    if ([...password].length < MIN_PASSWORD_LENGTH) throw new Error(`use at least ${MIN_PASSWORD_LENGTH} characters`);
    await opaque.ready;
    const pw = norm(password);
    const verification = current !== undefined ? await this.prove(current) : undefined;
    const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password: pw });
    const { response } = await this.c.http<{ response: string }>('POST', '/v1/2fa/password/register/start', { request: registrationRequest });
    const { registrationRecord } = opaque.client.finishRegistration({ clientRegistrationState, registrationResponse: response, password: pw, identifiers: ids(this.c.account.accountId), keyStretching: OPAQUE_KEY_STRETCHING });
    await this.c.http('POST', '/v1/2fa/password/register/finish', { record: registrationRecord, verification });
  }
  async removePassword(current: string) {
    await this.c.http('POST', '/v1/2fa/password/remove', { verification: await this.prove(current) });
  }
}
