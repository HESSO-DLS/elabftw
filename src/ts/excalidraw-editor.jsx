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

  const markClean = () => {
    const excalidrawApi = apiRef.current;
    if (!excalidrawApi) return;
    savedHashRef.current = sceneHash(excalidrawApi.getSceneElementsIncludingDeleted(), excalidrawApi.getFiles());
    isDirtyRef.current = true;
    setDirty(false);
  };

  const onChange = (elements, appState, files) => {
    if (ignoreChangesRef.current) return;
    if (savedHashRef.current === null) {
      savedHashRef.current = sceneHash(elements, files);
      return;
    }
    setDirty(sceneHash(elements, files) !== savedHashRef.current);
  };

  const loadScene = async (json) => {
    const excalidrawApi = apiRef.current;
    if (!excalidrawApi) throw new Error('Whiteboard editor is not ready.');
    const scene = await loadFromBlob(new Blob([json], { type: 'application/json' }), null, null);
    ignoreChangesRef.current = true;
    excalidrawApi.resetScene();
    excalidrawApi.addFiles(Object.values(scene.files || {}));
    excalidrawApi.updateScene({
      elements: scene.elements,
      appState: { viewBackgroundColor: scene.appState?.viewBackgroundColor ?? '#ffffff' },
    });
    excalidrawApi.history.clear();
    excalidrawApi.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 });
    // let excalidraw process the update before we start tracking changes again
    window.setTimeout(() => {
      ignoreChangesRef.current = false;
      markClean();
    }, 0);
  };

  const exportScene = async () => {
    const excalidrawApi = apiRef.current;
    if (!excalidrawApi) throw new Error('Whiteboard editor is not ready.');
    const elements = excalidrawApi.getSceneElements();
    if (elements.length === 0) throw new Error('The whiteboard is empty.');
    const appState = excalidrawApi.getAppState();
    const files = excalidrawApi.getFiles();
    const json = serializeAsJSON(elements, appState, files, 'local');
    const png = await exportToBlob({
      elements,
      files,
      mimeType: 'image/png',
      exportPadding: 16,
      appState: {
        ...appState,
        exportBackground: true,
        exportWithDarkMode: false,
        // the png also carries the scene so it can be reopened on excalidraw.com
        exportEmbedScene: true,
      },
    });
    return { json, png };
  };

  // warn before leaving the page with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!isDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // only accept a channel once the editor API is available
  useEffect(() => {
    if (!api) return;
    apiRef.current = api;
    ignoreChangesRef.current = false;

    const onPortMessage = async (event) => {
      const data = event.data;
      if (data?.type === 'exd-load-scene' && typeof data.json === 'string') {
        try {
          await loadScene(data.json);
        } catch (error) {
          portRef.current?.postMessage({ type: 'exd-error', message: error?.message || 'Could not load whiteboard.' });
        }
      } else if (data?.type === 'exd-saved') {
        markClean();
      } else if (data?.type === 'exd-scene-request' && typeof data.requestId === 'string') {
        try {
          const { json, png } = await exportScene();
          portRef.current?.postMessage({ type: 'exd-scene-response', requestId: data.requestId, json, png });
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
        <MainMenu.DefaultItems.ClearCanvas />
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
