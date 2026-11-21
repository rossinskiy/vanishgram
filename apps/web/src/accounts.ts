import type { VanishClient } from '@vanishgram/client-core';

export interface AccountEntry { id: string; label: string; active: boolean; locked: boolean; unread: number; client: VanishClient | null }

/** What the messenger screen may ask of the account manager (several accounts can be signed in at once). */
export interface AccountsApi {
  max: number;
  entries(): AccountEntry[];
  canAdd(): boolean;
  switchTo(id: string): void;
  add(): void;
  /** This account was signed out or deleted on this device. */
  loggedOut(id: string): void;
  logoutAll(): Promise<void>;
  /** Per-chat unread counts collected while this account was in the background. */
  takeUnread(id: string): Map<string, number>;
  setLabel(id: string, label: string): void;
}
