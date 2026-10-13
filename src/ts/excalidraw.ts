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

const AUTOSAVE_INTERVAL_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const section = document.getElementById('excalidrawEditor');
const iframe = document.getElementById('excalidrawIframe') as HTMLIFrameElement;
const statusEl = document.getElementById('excalidrawStatus');
const readonly = section?.dataset.readonly === '1';
const endpoint = `${entity.type}/${entity.id}/${Model.Whiteboard}`;

type Scene = { json: string; png: Blob | null; hash: string };
type StoredWhiteboard = { content: string; modified_at: string | null };

let portPromise: Promise<MessagePort> | null = null;
// modified_at of the version we started from, sent back on save to detect concurrent edits
let baseModifiedAt: string | null = null;
let dirty = false;
let saving = false;
let lastSaved: Date | null = null;
// once a save was refused because someone else saved in between, stop autosaving until reload
let conflict = false;

const setStatus = (text: string, isError = false): void => {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('text-danger', isError);
  statusEl.classList.toggle('text-muted', !isError);
};

const isIframeMessage = (event: MessageEvent, iframeWindow: Window | null): boolean => {
  // The iframe sandbox intentionally omits allow-same-origin, so its origin is opaque.
  return event.source === iframeWindow && event.origin === 'null';
};

const getPort = (): Promise<MessagePort> => {
  if (portPromise) return portPromise;
  const iframeWindow = iframe?.contentWindow;
  if (!iframeWindow) return Promise.reject(new Error('Whiteboard editor is not available.'));

  const connection = new Promise<MessagePort>((resolve, reject) => {
    let channel: MessageChannel | null = null;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      iframe.removeEventListener('load', ping);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (!isIframeMessage(event, iframeWindow)) return;
      if (event.data?.type !== 'exd-ready' || channel) return;
      channel = new MessageChannel();
      const onConnected = (portEvent: MessageEvent) => {
        if (portEvent.data?.type !== 'exd-connected') return;
        channel.port1.removeEventListener('message', onConnected);
        cleanup();
        resolve(channel.port1);
      };
      channel.port1.addEventListener('message', onConnected);
      channel.port1.start();
      iframeWindow.postMessage({ type: 'exd-connect' }, '*', [channel.port2]);
    };
    const ping = () => iframeWindow.postMessage({ type: 'exd-ping' }, '*');
    // excalidraw is big, give it time to load on slow connections
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Whiteboard editor did not become ready.'));
    }, RESPONSE_TIMEOUT_MS);
    const interval = window.setInterval(ping, 250);

    window.addEventListener('message', onMessage);
    iframe.addEventListener('load', ping, { once: true });
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

async function save(): Promise<void> {
  if (readonly || conflict || saving || !dirty) return;
  saving = true;
  setStatus('Saving…');
  try {
    const scene = await requestScene();
    const res = await ApiC.patch(endpoint, {
      content: scene.json,
      preview: scene.png ? await blobToDataUrl(scene.png) : '',
      base_modified_at: baseModifiedAt,
      notifOnSaved: 0,
      notifOnError: 0,
    });
    const stored: StoredWhiteboard = await res.json();
    baseModifiedAt = stored.modified_at;
    lastSaved = new Date();
    // the editor compares with the current scene: edits made during the save stay unsaved,
    // otherwise it answers with exd-dirty false and the status becomes "Saved at"
    setStatus('Unsaved changes');
    (await getPort()).postMessage({ type: 'exd-saved', hash: scene.hash });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected whiteboard error.';
    if (/changed by someone else/i.test(message)) {
      conflict = true;
      notify.error(message);
    }
    setStatus(`Not saved: ${message}`, true);
  } finally {
    saving = false;
  }
}

async function init(): Promise<void> {
  const stored = await ApiC.getJson<StoredWhiteboard>(endpoint);
  baseModifiedAt = stored.modified_at;
  // nothing to show to readers: hide the section and don't load the editor at all
  if (readonly && !stored.content) {
    section.hidden = true;
    return;
  }
  iframe.src = iframe.dataset.src;
  const port = await getPort();
  port.addEventListener('message', event => {
    if (event.data?.type === 'exd-dirty' && typeof event.data.dirty === 'boolean') {
      dirty = event.data.dirty;
      if (conflict) return;
      if (dirty) setStatus('Unsaved changes');
      else if (lastSaved) setStatus(`Saved at ${timeOfDay(lastSaved)}`);
    } else if (event.data?.type === 'exd-error' && typeof event.data.message === 'string') {
      notify.error(event.data.message);
    }
  });
  port.start();
  port.postMessage({ type: 'exd-config', readonly });
  port.postMessage({ type: 'exd-load-scene', json: stored.content });
  if (readonly) return;

  setStatus(stored.modified_at ? `Saved at ${timeOfDay(new Date(stored.modified_at.replace(' ', 'T')))}` : 'Changes are saved automatically');
  window.setInterval(() => void save(), AUTOSAVE_INTERVAL_MS);
  // save when the user switches tab or minimizes the window
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void save();
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
    setStatus(`Whiteboard not available: ${error instanceof Error ? error.message : error}`, true);
  });
}
