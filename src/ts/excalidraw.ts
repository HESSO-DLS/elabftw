/**
 * @copyright 2026 Simon Duerr
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Parent page side of the whiteboard editor (Excalidraw).
 * The editor itself runs in a sandboxed iframe (excalidraw-editor.jsx), we talk to it through a MessageChannel.
 * A whiteboard is stored as two attachments: "name.excalidraw" (the scene as JSON) and "name.excalidraw.png" (preview).
 */
import { Action, FileType, Model } from './interfaces';
import { askFileName, ensureTogglableSectionIsOpen, getNewIdFromPostRequest, reloadElements } from './misc';
import { ApiC } from './api';
import { entity } from './getEntity';
import { notify } from './notify';
import { on } from './handlers';

const RESPONSE_TIMEOUT_MS = 30_000;
const iframe = document.getElementById('excalidrawIframe') as HTMLIFrameElement;
const saveButton = document.getElementById('excalidrawSaveAsAttachment') as HTMLButtonElement;
const replaceButton = document.getElementById('excalidrawReplaceAttachment') as HTMLButtonElement;
const unsavedWarning = document.getElementById('excalidrawUnsavedChanges');

let portPromise: Promise<MessagePort> | null = null;
// the attachment currently loaded in the editor, if any
let currentUpload: { id: number; name: string } | null = null;
let dirty = false;
let saving = false;

type Scene = { json: string; png: Blob };
type UploadInfo = { id: number; real_name: string };

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
      if (typeof event.data.json !== 'string' || !(event.data.png instanceof Blob)) {
        reject(new Error('Whiteboard editor returned invalid data.'));
        return;
      }
      resolve({ json: event.data.json, png: event.data.png });
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Whiteboard editor did not respond.'));
    }, RESPONSE_TIMEOUT_MS);
    port.addEventListener('message', onMessage);
    port.postMessage({ type: 'exd-scene-request', requestId });
  });
};

const uploadUrl = (uploadId?: number): string => {
  const base = `api/v2/${entity.type}/${entity.id}/${Model.Upload}`;
  return uploadId ? `${base}/${uploadId}` : base;
};

// create a new attachment, or a new version of an existing one
async function postFile(file: File, uploadId?: number): Promise<number> {
  const fd = new FormData();
  fd.append('file', file);
  if (uploadId) fd.append('action', Action.Replace);
  const res = await fetch(uploadUrl(uploadId), { method: 'POST', body: fd });
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status})`);
  }
  return getNewIdFromPostRequest(res);
}

const previewName = (name: string): string => `${name}.png`;

async function findUploadByName(name: string): Promise<UploadInfo | undefined> {
  const uploads = await ApiC.getJson<UploadInfo[]>(`${entity.type}/${entity.id}/${Model.Upload}`);
  return uploads.find(upload => upload.real_name === name);
}

async function saveScene(scene: Scene, name: string, uploadId?: number): Promise<{ id: number; name: string }> {
  const id = await postFile(new File([scene.json], name, { type: 'application/json' }), uploadId);
  // keep the preview next to the scene: replace it if it exists, create it otherwise
  const pngName = previewName(name);
  const existingPreview = await findUploadByName(pngName);
  await postFile(new File([scene.png], pngName, { type: 'image/png' }), existingPreview?.id);
  return { id, name };
}

const setDirty = (value: boolean): void => {
  dirty = value;
  unsavedWarning.hidden = !dirty;
};

const updateButtons = (): void => {
  saveButton.disabled = saving;
  replaceButton.disabled = saving || !currentUpload;
};

async function withScene(callback: (scene: Scene) => Promise<{ id: number; name: string } | void>): Promise<void> {
  if (saving) return;
  saving = true;
  updateButtons();
  try {
    const scene = await requestScene();
    const result = await callback(scene);
    if (!result) return;
    currentUpload = result;
    notify.success();
    setDirty(false);
    (await getPort()).postMessage({ type: 'exd-saved' });
    reloadElements(['uploadsDiv']);
  } catch (error) {
    notify.error(error instanceof Error ? error.message : 'Unexpected whiteboard error.');
  } finally {
    saving = false;
    updateButtons();
  }
}

// LOAD A WHITEBOARD FROM AN ATTACHMENT
on('excalidraw-load-file', async (el: HTMLElement) => {
  if (dirty && !window.confirm('Discard current whiteboard? All unsaved changes will be lost.')) return;
  try {
    const res = await fetch(`app/download.php?f=${encodeURIComponent(el.dataset.path)}&storage=${el.dataset.storage}`, {
      headers: new Headers({ 'cache-control': 'no-cache' }),
    });
    if (!res.ok) throw new Error('Failed to fetch uploaded file.');
    const json = await res.text();
    ensureTogglableSectionIsOpen('excalidrawEditorIcon', 'excalidrawEditorContainer');
    (await getPort()).postMessage({ type: 'exd-load-scene', json });
    currentUpload = { id: Number(el.dataset.uploadid), name: el.dataset.name };
    setDirty(false);
    updateButtons();
  } catch (error) {
    notify.error(error instanceof Error ? error.message : 'Unexpected error while loading whiteboard.');
  }
});

if (iframe) {
  saveButton.addEventListener('click', () => {
    void withScene(async scene => {
      const name = askFileName(FileType.Excalidraw);
      if (!name) return;
      return saveScene(scene, name);
    });
  });

  replaceButton.addEventListener('click', () => {
    if (!currentUpload) return;
    const upload = currentUpload;
    void withScene(scene => saveScene(scene, upload.name, upload.id));
  });

  getPort().then(port => {
    port.addEventListener('message', event => {
      if (event.data?.type === 'exd-dirty' && typeof event.data.dirty === 'boolean') {
        setDirty(event.data.dirty);
      } else if (event.data?.type === 'exd-error' && typeof event.data.message === 'string') {
        notify.error(event.data.message);
      }
    });
    port.start();
  }).catch(error => notify.error(error instanceof Error ? error.message : 'Whiteboard editor is not available.'));

  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
