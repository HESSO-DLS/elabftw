/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Silent re-authentication for long open pages.
 * When the php session is lost (container restart, garbage collection) the api answers 401, but the
 * "remember me" cookie may still be valid: ReauthController.php goes through the normal login code,
 * which logs the user back in from that cookie, without leaving the page.
 */

// event dispatched right before the page sends the user to the login page,
// so components with unsaved work (whiteboard) can keep a local copy:
// they push a promise to event.detail.waitUntil, the redirect waits for it (a few seconds at most)
export const SESSION_EXPIRED_EVENT = 'elab:session-expired';
export type SessionExpiredDetail = { waitUntil: Promise<unknown>[] };

export async function announceSessionExpired(maxWaitMs = 5000): Promise<void> {
  const detail: SessionExpiredDetail = { waitUntil: [] };
  document.dispatchEvent(new CustomEvent<SessionExpiredDetail>(SESSION_EXPIRED_EVENT, { detail }));
  if (detail.waitUntil.length === 0) return;
  await Promise.race([
    Promise.allSettled(detail.waitUntil),
    new Promise(resolve => window.setTimeout(resolve, maxWaitMs)),
  ]);
}

let pending: Promise<boolean> | null = null;

// with an inactivity logout configured, an expired session must not be revived silently
const autologoutActive = (): boolean => {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="session-expires-at"]');
  return Number(meta?.content ?? 0) > 0;
};

export function reauthenticate(): Promise<boolean> {
  if (autologoutActive()) return Promise.resolve(false);
  if (pending) return pending;
  pending = fetch('app/controllers/ReauthController.php', {
    credentials: 'same-origin',
    cache: 'no-store',
    // no redirect to the logout page for ajax requests, see init.inc.php
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  }).then(async response => {
    if (!response.ok || response.headers.get('X-Elab-Need-Auth') === '1') return false;
    const json = await response.json().catch(() => null);
    return json?.ok === true;
  }).catch(() => false).finally(() => {
    pending = null;
  });
  return pending;
}
