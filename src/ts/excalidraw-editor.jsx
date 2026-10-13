/**
 * @copyright 2026 Simon Duerr
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Whiteboard editor (Excalidraw) running inside a sandboxed iframe on the edit page of an entity.
 * It talks to the parent page through a private MessageChannel (see excalidraw-utils.ts),
 * the same way the spreadsheet editor does.
 */

// fonts are self-hosted (copied by builder.js), this must be set before excalidraw is loaded
// location.origin is the real origin even if the sandboxed document has an opaque one
window.EXCALIDRAW_ASSET_PATH = `${window.location.origin}/assets/excalidraw/`;

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@excalidraw/excalidraw/index.css';
import './excalidraw-iframe.css';

function ExcalidrawEditor({ lib }) {
  const { Excalidraw, MainMenu, WelcomeScreen, exportToBlob, hashElementsVersion, loadFromBlob, serializeAsJSON } = lib;
  const [api, setApi] = useState(null);
  const [readonly, setReadonly] = useState(true);
  const apiRef = useRef(null);
  const portRef = useRef(null);
  const isDirtyRef = useRef(false);
  // hash of the scene when it was last loaded or saved, used to detect changes
  const savedHashRef = useRef(null);
  // ignore change events until the editor has settled after an update
  const ignoreChangesRef = useRef(true);

  const sceneHash = (elements, files) => `${hashElementsVersion(elements)}-${Object.keys(files || {}).length}`;

  const setDirty = (dirty) => {
    if (isDirtyRef.current === dirty) return;
    isDirtyRef.current = dirty;
    portRef.current?.postMessage({ type: 'exd-dirty', dirty });
  };

  const currentHash = () => {
    const excalidrawApi = apiRef.current;
    return sceneHash(excalidrawApi.getSceneElementsIncludingDeleted(), excalidrawApi.getFiles());
  };

  // hash: the scene version that was saved, edits made since then stay dirty
  const markClean = (hash) => {
    if (!apiRef.current) return;
    savedHashRef.current = hash ?? currentHash();
    isDirtyRef.current = true;
    setDirty(currentHash() !== savedHashRef.current);
  };

  const onChange = (elements, appState, files) => {
    if (ignoreChangesRef.current) return;
    if (savedHashRef.current === null) {
      savedHashRef.current = sceneHash(elements, files);
      return;
    }
    setDirty(sceneHash(elements, files) !== savedHashRef.current);
  };

  // always start at 100% with the drawing centered
  const centerContent = () => {
    const excalidrawApi = apiRef.current;
    if (!excalidrawApi) return;
    excalidrawApi.updateScene({ appState: { zoom: { value: 1 } } });
    if (excalidrawApi.getSceneElements().length === 0) return;
    excalidrawApi.scrollToContent(undefined, { animate: false });
  };

  // an empty json means the entity has no whiteboard yet
  const loadScene = async (json) => {
    const excalidrawApi = apiRef.current;
    if (!excalidrawApi) throw new Error('Whiteboard editor is not ready.');
    ignoreChangesRef.current = true;
    const scene = json ? await loadFromBlob(new Blob([json], { type: 'application/json' }), null, null) : null;
    // don't use resetScene(): it also resets the app state, view mode included
    excalidrawApi.addFiles(Object.values(scene?.files || {}));
    excalidrawApi.updateScene({
      elements: scene?.elements ?? [],
      appState: { viewBackgroundColor: scene?.appState?.viewBackgroundColor ?? '#ffffff' },
    });
    excalidrawApi.history.clear();
    // the section can be collapsed (zero size) on load: center again once it is shown
    if (window.innerWidth > 0) {
      centerContent();
    } else {
      window.addEventListener('resize', centerContent, { once: true });
    }
    // let excalidraw process the update before we start tracking changes again
    window.setTimeout(() => {
      ignoreChangesRef.current = false;
      markClean();
    }, 0);
  };

  // the scene as json, a png preview (null when empty) and the hash of what is exported
  const exportScene = async () => {
    const excalidrawApi = apiRef.current;
    if (!excalidrawApi) throw new Error('Whiteboard editor is not ready.');
    const hash = currentHash();
    const elements = excalidrawApi.getSceneElements();
    const appState = excalidrawApi.getAppState();
    const files = excalidrawApi.getFiles();
    const json = serializeAsJSON(elements, appState, files, 'local');
    const png = elements.length === 0 ? null : await exportToBlob({
      elements,
      files,
      mimeType: 'image/png',
      exportPadding: 16,
      appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
    });
    return { json, png, hash };
  };

  // only accept a channel once the editor API is available
  useEffect(() => {
    if (!api) return;
    apiRef.current = api;
    ignoreChangesRef.current = false;

    const onPortMessage = async (event) => {
      const data = event.data;
      if (data?.type === 'exd-config') {
        setReadonly(data.readonly !== false);
      } else if (data?.type === 'exd-load-scene' && typeof data.json === 'string') {
        try {
          await loadScene(data.json);
          portRef.current?.postMessage({ type: 'exd-loaded' });
        } catch (error) {
          portRef.current?.postMessage({ type: 'exd-error', message: error?.message || 'Could not load whiteboard.' });
        }
      } else if (data?.type === 'exd-saved') {
        markClean(typeof data.hash === 'string' ? data.hash : undefined);
      } else if (data?.type === 'exd-scene-request' && typeof data.requestId === 'string') {
        try {
          const { json, png, hash } = await exportScene();
          portRef.current?.postMessage({ type: 'exd-scene-response', requestId: data.requestId, json, png, hash });
        } catch (error) {
          portRef.current?.postMessage({ type: 'exd-scene-response', requestId: data.requestId, error: error?.message || 'Could not export whiteboard.' });
        }
      }
    };
    const onMessage = (event) => {
      if (event.source !== window.parent) return;
      if (event.data?.type === 'exd-ping') {
        window.parent.postMessage({ type: 'exd-ready' }, '*');
      } else if (event.data?.type === 'exd-connect' && !portRef.current) {
        const port = event.ports?.[0];
        if (!port) return;
        portRef.current = port;
        port.addEventListener('message', onPortMessage);
        port.start();
        port.postMessage({ type: 'exd-connected' });
      }
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'exd-ready' }, '*');
    return () => {
      window.removeEventListener('message', onMessage);
      portRef.current?.removeEventListener('message', onPortMessage);
      portRef.current?.close();
      portRef.current = null;
    };
  }, [api]);

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      onChange={onChange}
      viewModeEnabled={readonly}
      UIOptions={{
        canvasActions: {
          // saving and loading is done by eLabFTW
          export: false,
          loadScene: false,
          saveAsImage: false,
          saveToActiveFile: false,
        },
      }}
    >
      <MainMenu>
        {!readonly && <MainMenu.DefaultItems.ClearCanvas />}
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
      <WelcomeScreen>
        <WelcomeScreen.Hints.ToolbarHint />
        <WelcomeScreen.Hints.HelpHint />
      </WelcomeScreen>
    </Excalidraw>
  );
}

const el = document.getElementById('excalidrawEditorRoot');
if (el) {
  // load excalidraw only after the asset path is set
  import(/* webpackChunkName: "excalidraw-lib" */ '@excalidraw/excalidraw').then(lib => {
    createRoot(el).render(<ExcalidrawEditor lib={lib} />);
  });
}
