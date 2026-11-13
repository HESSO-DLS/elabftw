/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Parent page side of the whiteboard (Excalidraw).
 * Each entity has one whiteboard, stored with the whiteboard api submodel. It is loaded with the page and autosaved.
 * The editor itself runs in a sandboxed iframe (excalidraw-editor.jsx), we talk to it through a MessageChannel.
 */
import { Model } from './interfaces';
import { ApiC } from './api';
import { entity } from './getEntity';
import { notify } from './notify';
import { reauthenticate, SESSION_EXPIRED_EVENT } from './reauth';
import type { SessionExpiredDetail } from './reauth';

const AUTOSAVE_INTERVAL_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 60_000;
// a request that never settles (sleeping laptop, network change) must not block later saves
const SAVE_TIMEOUT_MS = 90_000;
const OFFER_RETRY_MS = 2_000;
const section = document.getElementById('excalidrawEditor');
const iframe = document.getElementById('excalidrawIframe') as HTMLIFrameElement;
const statusEl = document.getElementById('excalidrawStatus');
const readonly = section?.dataset.readonly === '1';
const endpoint = `${entity.type}/${entity.id}/${Model.Whiteboard}`;
// local copy of a scene that could not be saved because the session expired
// the persistent_ prefix keeps it when the local storage is cleared on logout
const backupKey = `persistent_whiteboard_${entity.type}_${entity.id}`;

type Scene = { json: string; png: Blob | null; hash: string };
type StoredWhiteboard = { content: string; modified_at: string | null };
type Backup = { json: string; savedAt: string };
type ErrorWithStatus = Error & { status?: number };

let portPromise: Promise<MessagePort> | null = null;
// listeners survive reconnections: they are attached to every new port
const portListeners: Array<(event: MessageEvent) => void> = [];
// the scene to (re)load in the editor when its document starts: the stored one, then the last exported one
let sceneJson = '';
// true until the editor document got the scene: on first connection and after it was reloaded
let needsScene = true;
// modified_at of the version we started from, sent back on save to detect concurrent edits
let baseModifiedAt: string | null = null;
let dirty = false;
let saving = false;
let lastSaved: Date | null = null;
// once a save was refused because someone else saved in between, stop autosaving until reload
let conflict = false;
// save once the restored scene is loaded in the editor
let saveWhenLoaded = false;

type StatusKind = 'pending' | 'saving' | 'saved' | 'error';
const statusIcons: Record<StatusKind, string> = {
  pending: 'fa-cloud-arrow-up',
  saving: 'fa-spinner fa-spin',
  saved: 'fa-check',
  error: 'fa-triangle-exclamation',
};

const setStatus = (kind: StatusKind, text: string): void => {
  if (!statusEl) return;
  const icon = document.createElement('i');
  icon.className = `fas fa-fw mr-1 ${statusIcons[kind]}`;
  icon.setAttribute('aria-hidden', 'true');
  statusEl.replaceChildren(icon, document.createTextNode(text));
  statusEl.classList.toggle('text-danger', kind === 'error');
  statusEl.classList.toggle('text-muted', kind !== 'error');
};

const hideLoading = (): void => {
  document.getElementById('excalidrawLoading')?.setAttribute('hidden', 'hidden');
};

const readBackup = (): Backup | null => {
  try {
    const backup = JSON.parse(localStorage.getItem(backupKey) ?? 'null');
    return typeof backup?.json === 'string' && typeof backup?.savedAt === 'string' ? backup : null;
  } catch {
    return null;
  }
};

const writeBackup = (json: string): void => {
  try {
    localStorage.setItem(backupKey, JSON.stringify({ json, savedAt: new Date().toISOString() }));
  } catch (error) {
    // quota exceeded with big embedded images: nothing more we can do
    console.warn('Could not keep a local copy of the whiteboard', error);
  }
};

const clearBackup = (): void => {
  try {
    localStorage.removeItem(backupKey);
  } catch {
    // storage not available
  }
};

const isIframeMessage = (event: MessageEvent, iframeWindow: Window | null): boolean => {
  // The iframe sandbox intentionally omits allow-same-origin, so its origin is opaque.
  return event.source === iframeWindow && event.origin === 'null';
};

// a new connection: tell the editor its mode, and give it the scene if its document just started
const onConnected = (port: MessagePort): void => {
  port.postMessage({ type: 'exd-config', readonly });
  if (needsScene) {
    needsScene = false;
    port.postMessage({ type: 'exd-load-scene', json: sceneJson });
  }
};

// forget a connection that stopped answering, the next request connects again
const dropPort = (port: MessagePort): void => {
  void portPromise?.then(current => {
    if (current !== port) return;
    port.close();
    portPromise = null;
  }, () => {});
};

const getPort = (): Promise<MessagePort> => {
  if (portPromise) return portPromise;
  const iframeWindow = iframe?.contentWindow;
  if (!iframeWindow) return Promise.reject(new Error('Whiteboard editor is not available.'));

  const connection = new Promise<MessagePort>((resolve, reject) => {
    // a new channel is offered on each exd-ready until one is accepted, so a lost connect message can't block us
    let channel: MessageChannel | null = null;
    let offeredAt = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      iframe.removeEventListener('load', ping);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (!isIframeMessage(event, iframeWindow)) return;
      if (event.data?.type !== 'exd-ready') return;
      // give the current offer time to be answered before replacing it
      if (channel && Date.now() - offeredAt < OFFER_RETRY_MS) return;
      channel?.port1.close();
      const offered = new MessageChannel();
      channel = offered;
      offeredAt = Date.now();
      offered.port1.onmessage = (portEvent: MessageEvent) => {
        if (portEvent.data?.type !== 'exd-connected' || channel !== offered) return;
        offered.port1.onmessage = null;
        cleanup();
        portListeners.forEach(listener => offered.port1.addEventListener('message', listener));
        offered.port1.start();
        // the editor document was reloaded (crash, memory pressure): its end of the channel is gone,
        // connect again and give it back the scene
        const onReload = (readyEvent: MessageEvent) => {
          if (!isIframeMessage(readyEvent, iframeWindow)) return;
          if (readyEvent.data?.type !== 'exd-ready' || readyEvent.data.fresh !== true) return;
          window.removeEventListener('message', onReload);
          offered.port1.close();
          if (portPromise) portPromise = null;
          needsScene = true;
          dirty = false;
          void getPort().catch(error => console.warn(error));
        };
        window.addEventListener('message', onReload);
        onConnected(offered.port1);
        resolve(offered.port1);
      };
      iframeWindow.postMessage({ type: 'exd-connect' }, '*', [offered.port2]);
    };
    const ping = () => iframeWindow.postMessage({ type: 'exd-ping' }, '*');
    // excalidraw is big, give it time to load on slow connections or busy computers
    const timeout = window.setTimeout(() => {
      cleanup();
      channel?.port1.close();
      reject(new Error('Whiteboard editor did not become ready.'));
    }, CONNECT_TIMEOUT_MS);
    const interval = window.setInterval(ping, 250);

    window.addEventListener('message', onMessage);
    iframe.addEventListener('load', ping);
    ping();
  });
  portPromise = connection.catch(error => {
    portPromise = null;
    throw error;
  });
  return portPromise;
};

const requestScene = async (): Promise<Scene> => {
  const port = await getPort();
  const requestId = crypto.randomUUID();
  return new Promise<Scene>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      port.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'exd-scene-response' || event.data.requestId !== requestId) return;
      cleanup();
      if (typeof event.data.error === 'string') {
        reject(new Error(event.data.error));
        return;
      }
      const { json, png, hash } = event.data;
      if (typeof json !== 'string' || typeof hash !== 'string' || !(png === null || png instanceof Blob)) {
        reject(new Error('Whiteboard editor returned invalid data.'));
        return;
      }
      resolve({ json, png, hash });
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      // the channel may be dead: connect again on the next save
      dropPort(port);
      reject(new Error('Whiteboard editor did not respond.'));
    }, RESPONSE_TIMEOUT_MS);
    port.addEventListener('message', onMessage);
    port.postMessage({ type: 'exd-scene-request', requestId });
  });
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const timeOfDay = (date: Date): string => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const patchScene = (content: string, preview: string): Promise<Response> => ApiC.patch(endpoint, {
  content,
  preview,
  base_modified_at: baseModifiedAt,
  notifOnSaved: 0,
  notifOnError: 0,
}, { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) });

// force: save even if the editor reports no change (restoring a local copy)
async function save(force = false): Promise<void> {
  if (readonly || conflict || saving || !(dirty || force)) return;
  saving = true;
  setStatus('saving', 'Saving…');
  let scene: Scene | null = null;
  try {
    scene = await requestScene();
    sceneJson = scene.json;
    const preview = scene.png ? await blobToDataUrl(scene.png) : '';
    let res: Response;
    try {
      res = await patchScene(scene.json, preview);
    } catch (error) {
      // the session is gone: log in again from the "remember me" cookie if possible, then retry once
      if ((error as ErrorWithStatus).status !== 401 || !await reauthenticate()) throw error;
      res = await patchScene(scene.json, preview);
    }
    const stored: StoredWhiteboard = await res.json();
    baseModifiedAt = stored.modified_at;
    lastSaved = new Date();
    clearBackup();
    // the editor compares with the current scene: edits made during the save stay unsaved,
    // otherwise it answers with exd-dirty false and the status becomes "Saved at"
    setStatus('pending', 'Will be saved automatically');
    (await getPort()).postMessage({ type: 'exd-saved', hash: scene.hash });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected whiteboard error.';
    if ((error as ErrorWithStatus).status === 401) {
      // keep the drawing in this browser, it is offered back on the next visit
      if (scene) writeBackup(scene.json);
      setStatus('error', 'Not saved: your session has expired. Log in again (e.g. in a new tab), saving resumes by itself; a copy is kept in this browser.');
    } else if (/changed by someone else/i.test(message)) {
      conflict = true;
      notify.error(message);
      setStatus('error', `Not saved: ${message}`);
    } else if (/timed? ?out|abort/i.test(message)) {
      setStatus('error', 'Not saved: the server took too long to answer, retrying automatically.');
    } else {
      setStatus('error', `Not saved: ${message}`);
    }
  } finally {
    saving = false;
  }
}

const offerRestore = (): void => {
  const backup = readBackup();
  const banner = document.getElementById('excalidrawRecovery');
  if (!backup || !banner) return;
  const dateEl = document.getElementById('excalidrawRecoveryDate');
  if (dateEl) dateEl.textContent = new Date(backup.savedAt).toLocaleString();
  banner.hidden = false;
  document.getElementById('excalidrawRecoveryRestore')?.addEventListener('click', async () => {
    banner.hidden = true;
    sceneJson = backup.json;
    saveWhenLoaded = true;
    (await getPort()).postMessage({ type: 'exd-load-scene', json: backup.json });
  }, { once: true });
  document.getElementById('excalidrawRecoveryDiscard')?.addEventListener('click', () => {
    banner.hidden = true;
    clearBackup();
  }, { once: true });
};

async function init(): Promise<void> {
  const stored = await ApiC.getJson<StoredWhiteboard>(endpoint);
  baseModifiedAt = stored.modified_at;
  // nothing to show to readers: keep the section hidden and don't load the editor at all
  if (readonly && !stored.content) return;
  section.hidden = false;
  sceneJson = stored.content;
  portListeners.push(event => {
    if (event.data?.type === 'exd-dirty' && typeof event.data.dirty === 'boolean') {
      dirty = event.data.dirty;
      if (conflict) return;
      if (dirty) setStatus('pending', 'Will be saved automatically');
      else if (lastSaved) setStatus('saved', `Saved at ${timeOfDay(lastSaved)}`);
    } else if (event.data?.type === 'exd-loaded') {
      hideLoading();
      if (saveWhenLoaded) {
        saveWhenLoaded = false;
        void save(true);
      }
    } else if (event.data?.type === 'exd-error' && typeof event.data.message === 'string') {
      hideLoading();
      notify.error(event.data.message);
    }
  });
  iframe.src = iframe.dataset.src;
  // the port gets the listeners, the mode and the scene when it connects
  await getPort();
  if (readonly) return;

  if (stored.modified_at) {
    lastSaved = new Date(stored.modified_at.replace(' ', 'T'));
    setStatus('saved', `Saved at ${timeOfDay(lastSaved)}`);
  } else {
    setStatus('pending', 'Changes are saved automatically');
  }
  offerRestore();
  window.setInterval(() => void save(), AUTOSAVE_INTERVAL_MS);
  // save when the user switches tab or minimizes the window, and when coming back (e.g. after sleep)
  document.addEventListener('visibilitychange', () => void save());
  // the page is about to send the user to the login page: keep the unsaved drawing in this browser
  document.addEventListener(SESSION_EXPIRED_EVENT, (event: Event) => {
    if (!dirty) return;
    (event as CustomEvent<SessionExpiredDetail>).detail?.waitUntil.push(requestScene().then(scene => writeBackup(scene.json)));
  });
  // at most the last minute can be lost: warn before leaving
  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    void save();
    event.preventDefault();
    event.returnValue = '';
  });
}

if (iframe && section) {
  init().catch(error => {
    hideLoading();
    setStatus('error', `Whiteboard not available: ${error instanceof Error ? error.message : error}`);
  });
}
