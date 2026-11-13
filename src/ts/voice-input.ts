/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Voice input for the main text, with the Web Speech API of Chrome.
 * Speech is ONLY recognized on device (processLocally): if the browser can't do that, the button stays disabled,
 * there is no fallback to a cloud service.
 * - the mic button (or Ctrl+Shift+Space) starts and stops dictation
 * - "Alo" / "Alo stop" voice commands (voice-commands.ts), and a listen mode that waits for "Alo"
 */
import tinymce from 'tinymce/tinymce';
import i18next from './i18n';
import { ApiC } from './api';
import { getEditor } from './Editor.class';
import { getEntity, reloadElements, updateEntityBody } from './misc';
import { notify } from './notify';
import { parseCommands, stripCommands } from './voice-commands';

// the Web Speech API types are not in the TS dom lib for all versions: describe what we use
type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
interface RecognitionAlternative { transcript: string }
interface RecognitionResult { isFinal: boolean; length: number; [index: number]: RecognitionAlternative }
interface RecognitionEvent extends Event { resultIndex: number; results: { length: number; [index: number]: RecognitionResult } }
interface RecognitionErrorEvent extends Event { error: string; message?: string }
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  mode?: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionConstructor {
  new (): Recognition;
  prototype: Recognition;
  // Chrome 139+
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<Availability>;
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
  // Chrome 138 origin trial names
  availableOnDevice?: (lang: string) => Promise<Availability>;
  installOnDevice?: (lang: string) => Promise<boolean>;
}

type Mode = 'idle' | 'listening' | 'recording';

const LANGS: Array<[string, string]> = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['fr-FR', 'Français'],
  ['fr-CH', 'Français (Suisse)'],
  ['de-DE', 'Deutsch'],
  ['de-CH', 'Deutsch (Schweiz)'],
  ['it-IT', 'Italiano'],
  ['es-ES', 'Español'],
  ['pt-PT', 'Português'],
  ['nl-NL', 'Nederlands'],
];
const LANG_KEY = 'persistent_voice_lang';
const LISTEN_KEY = 'persistent_voice_listen';
const SAVE_DEBOUNCE_MS = 3000;

const NEW_PARAGRAPH_RE = /\b(?:new paragraph|nouveau paragraphe|neuer absatz)\b/gi;
const NEW_LINE_RE = /\b(?:new line|newline|nouvelle ligne|à la ligne|neue zeile)\b/gi;

const t = (key: string, fallback: string): string => i18next.t(key, { defaultValue: fallback }) as string;

const Ctor = ((window as unknown as { SpeechRecognition?: RecognitionConstructor }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: RecognitionConstructor }).webkitSpeechRecognition) ?? null;

const micBtn = document.getElementById('voiceMicBtn') as HTMLButtonElement | null;
const listenToggle = document.getElementById('voiceListenToggle') as HTMLInputElement | null;
const langSelect = document.getElementById('voiceLangSelect') as HTMLSelectElement | null;
const modelStatus = document.getElementById('voiceModelStatus');
const installBtn = document.getElementById('voiceInstallBtn') as HTMLButtonElement | null;
const statusBox = document.getElementById('voiceStatus');
const statusText = document.getElementById('voiceStatusText');
const interimEl = document.getElementById('voiceInterim');
const stopBtn = document.getElementById('voiceStopBtn');

let mode: Mode = 'idle';
let rec: Recognition | null = null;
let running = false;
let available = false;
let restartDelay = 250;
let saveTimer = 0;
let pausedForHidden = false;
// a recognizer stopped from the button while recording: its last results are still dictated
let draining: Recognition | null = null;
// recording stopped from the button: words said right before the click are still dictated for a moment
const MANUAL_STOP_GRACE_MS = 1500;
let manualStopAt = 0;

const storage = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage not available
    }
  },
};

const lang = (): string => langSelect?.value || 'en-US';

// fr_FR -> fr-FR, and the closest language in the list
const defaultLang = (): string => {
  const stored = storage.get(LANG_KEY);
  if (stored && LANGS.some(([code]) => code === stored)) return stored;
  const userLang = (document.getElementById('user-prefs')?.dataset.lang ?? navigator.language ?? 'en-US').replace('_', '-');
  return LANGS.find(([code]) => code.toLowerCase() === userLang.toLowerCase())?.[0]
    ?? LANGS.find(([code]) => code.slice(0, 2) === userLang.slice(0, 2).toLowerCase())?.[0]
    ?? 'en-US';
};

// can this browser recognize speech on device? never use a recognizer that could send audio away
const supportsLocal = (): boolean => {
  if (!Ctor) return false;
  return 'processLocally' in Ctor.prototype || typeof Ctor.available === 'function' || typeof Ctor.availableOnDevice === 'function';
};

const checkAvailability = async (): Promise<Availability> => {
  if (!Ctor || !supportsLocal()) return 'unavailable';
  try {
    if (typeof Ctor.available === 'function') return await Ctor.available({ langs: [lang()], processLocally: true });
    if (typeof Ctor.availableOnDevice === 'function') return await Ctor.availableOnDevice(lang());
  } catch (error) {
    console.warn('Speech recognition availability check failed', error);
  }
  return 'unavailable';
};

const renderAvailability = async (): Promise<void> => {
  const state = await checkAvailability();
  available = state === 'available';
  if (micBtn) {
    micBtn.disabled = !available;
    if (!supportsLocal()) {
      micBtn.title = t('voice-unsupported', 'On-device speech recognition needs a recent Chrome (139 or newer). Audio is never sent to a server.');
    }
  }
  if (listenToggle) listenToggle.disabled = !available;
  if (installBtn) installBtn.hidden = !(state === 'downloadable');
  if (modelStatus) {
    modelStatus.textContent = {
      available: t('voice-model-ready', 'Speech model installed on this computer.'),
      downloadable: t('voice-model-downloadable', 'The speech model for this language must be downloaded once.'),
      downloading: t('voice-model-downloading', 'Downloading the speech model…'),
      unavailable: supportsLocal()
        ? t('voice-model-unavailable', 'No on-device speech model for this language.')
        : t('voice-unsupported', 'On-device speech recognition needs a recent Chrome (139 or newer). Audio is never sent to a server.'),
    }[state];
  }
  if (state === 'downloading') window.setTimeout(() => void renderAvailability(), 3000);
  if (!available && mode !== 'idle') setMode('idle');
};

/////////////
// INSERTION

const tiny = () => (getEditor().type === 'tiny' ? tinymce.get(0) : null);

// character right before the cursor, to know if a space or a capital letter is needed
const charBeforeCursor = (): string => {
  const editor = tiny();
  if (editor) {
    const rng = editor.selection.getRng();
    const node = rng.startContainer;
    if (node.nodeType === Node.TEXT_NODE && rng.startOffset > 0) return (node.textContent ?? '').charAt(rng.startOffset - 1);
    // at the start of a block
    return '\n';
  }
  const area = document.getElementById('body_area') as HTMLTextAreaElement | null;
  if (!area) return '';
  return area.value.charAt(area.selectionStart - 1) || '\n';
};

const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const insertText = (raw: string): void => {
  let text = raw.trim();
  if (!text) return;
  const before = charBeforeCursor();
  if (before === '' || before === '\n' || /[.!?]\s*$/.test(before)) {
    text = text.charAt(0).toLocaleUpperCase() + text.slice(1);
  }
  if (before !== '' && before !== '\n' && !/\s/.test(before)) text = ` ${text}`;
  const editor = tiny();
  if (editor) {
    // one undo step per dictated segment
    editor.undoManager.transact(() => editor.insertContent(escapeHtml(text)));
    return;
  }
  const area = document.getElementById('body_area') as HTMLTextAreaElement | null;
  if (!area) return;
  area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
};

const insertBreak = (paragraph: boolean): void => {
  const editor = tiny();
  if (editor) {
    editor.undoManager.transact(() => editor.execCommand(paragraph ? 'mceInsertNewLine' : 'InsertLineBreak'));
    return;
  }
  const area = document.getElementById('body_area') as HTMLTextAreaElement | null;
  area?.setRangeText(paragraph ? '\n\n' : '\n', area.selectionStart, area.selectionEnd, 'end');
};

// text with "new line" / "new paragraph" commands in it
const dictate = (text: string): void => {
  const parts = text.split(/(\bnew paragraph\b|\bnouveau paragraphe\b|\bneuer absatz\b|\bnew ?line\b|\bnouvelle ligne\b|\bà la ligne\b|\bneue zeile\b)/i);
  for (const part of parts) {
    if (!part) continue;
    if (NEW_PARAGRAPH_RE.test(part)) {
      NEW_PARAGRAPH_RE.lastIndex = 0;
      insertBreak(true);
    } else if (NEW_LINE_RE.test(part)) {
      NEW_LINE_RE.lastIndex = 0;
      insertBreak(false);
    } else {
      insertText(part);
    }
  }
  scheduleSave();
};

////////////
// SAVING

// inserted text doesn't trigger the keyup autosave: save quietly a moment after the last segment
const save = async (): Promise<void> => {
  window.clearTimeout(saveTimer);
  const editor = getEditor();
  const entity = getEntity();
  try {
    const response = await ApiC.patch(`${entity.type}/${entity.id}`, { body: editor.getContent(), notifOnSaved: 0, notifOnError: 0 });
    const json = await response.json();
    tiny()?.setDirty(false);
    const lastSavedAt = document.getElementById('lastSavedAt');
    if (lastSavedAt && json?.modified_at) {
      lastSavedAt.title = json.modified_at;
      void reloadElements(['lastSavedAt']);
    }
  } catch {
    // the usual path keeps a local copy and sends to the login page if the session is gone
    void updateEntityBody(false);
  }
};

const scheduleSave = (): void => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
};

//////////////
// RECOGNITION

const renderMode = (): void => {
  micBtn?.classList.toggle('voice-recording', mode === 'recording');
  micBtn?.classList.toggle('voice-listening', mode === 'listening');
  micBtn?.setAttribute('aria-pressed', mode === 'recording' ? 'true' : 'false');
  const icon = micBtn?.querySelector('i');
  if (icon) icon.className = `fas fa-fw ${mode === 'listening' ? 'fa-ear-listen' : 'fa-microphone'}`;
  if (!statusBox) return;
  statusBox.hidden = mode === 'idle';
  statusBox.classList.toggle('voice-status-recording', mode === 'recording');
  if (statusText) {
    statusText.textContent = mode === 'recording'
      ? t('voice-recording-alo', 'Recording… say "Alo stop" to stop')
      : t('voice-listening-alo', 'Listening for "Alo"');
  }
  if (interimEl) interimEl.textContent = '';
};

// manual: stopped with the button, not with the voice command
function setMode(next: Mode, manual = false): void {
  const previous = mode;
  mode = next;
  renderMode();
  const stoppedRecording = previous === 'recording' && next !== 'recording';
  if (stoppedRecording) void save();
  if (stoppedRecording && manual) manualStopAt = Date.now();
  if (next === 'idle') {
    // the words said right before a click on stop are still being recognized: keep them
    stopEngine(stoppedRecording && manual);
  } else {
    startEngine();
  }
}

const stopRecording = (manual = false): void => setMode(listenToggle?.checked ? 'listening' : 'idle', manual);

// the text of a final result: commands switch mode, the rest is dictated while recording
const handleFinal = (transcript: string): void => {
  const justStopped = mode === 'listening' && Date.now() - manualStopAt < MANUAL_STOP_GRACE_MS;
  for (const part of parseCommands(transcript)) {
    if ('text' in part) {
      if (mode === 'recording' || justStopped) dictate(part.text);
    } else if (part.command === 'start') {
      // "Alo" while recording is ignored (and not inserted)
      if (mode !== 'recording') setMode('recording');
    } else if (mode === 'recording') {
      stopRecording();
    }
  }
};

const createRecognition = (): Recognition | null => {
  if (!Ctor) return null;
  const recognition = new Ctor();
  // hard requirement: recognition on this computer only
  if ('processLocally' in recognition) {
    recognition.processLocally = true;
  } else if ('mode' in recognition) {
    recognition.mode = 'ondevice-only';
  } else {
    return null;
  }
  recognition.lang = lang();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    restartDelay = 250;
  };
  recognition.onresult = event => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        if (recognition === draining) {
          dictate(stripCommands(transcript));
        } else if (recognition === rec) {
          handleFinal(transcript);
        }
      } else {
        interim += transcript;
      }
    }
    if (interimEl) interimEl.textContent = mode === 'recording' ? stripCommands(interim) : '';
  };
  recognition.onerror = event => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    if (['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(event.error)) {
      const messages: Record<string, string> = {
        'not-allowed': t('voice-mic-denied', 'Microphone access was refused.'),
        'audio-capture': t('voice-no-mic', 'No microphone was found.'),
      };
      notify.error(messages[event.error] ?? t('voice-model-unavailable', 'No on-device speech model for this language.'));
      setMode('idle');
      void renderAvailability();
      return;
    }
    console.warn('Speech recognition error', event.error, event.message);
  };
  // Chrome ends sessions by itself (silence, time limit): start again while we are active
  recognition.onend = () => {
    // dictated text schedules its own save
    if (recognition === draining) {
      draining = null;
      return;
    }
    running = false;
    if (rec !== recognition || mode === 'idle' || pausedForHidden) return;
    window.setTimeout(() => {
      if (rec === recognition && mode !== 'idle' && !running) startEngine();
    }, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 5000);
  };
  return recognition;
};

function startEngine(): void {
  if (running || !available) return;
  if (!rec || rec.lang !== lang()) {
    rec?.abort();
    rec = createRecognition();
  }
  if (!rec) {
    setMode('idle');
    return;
  }
  try {
    rec.start();
    running = true;
  } catch (error) {
    // already started
    console.warn(error);
  }
}

// drain: stop (not abort) still delivers the last final result, dictate it
function stopEngine(drain = false): void {
  if (!rec) return;
  const current = rec;
  rec = null;
  running = false;
  if (drain) {
    draining = current;
  } else {
    current.onresult = null;
  }
  try {
    current.stop();
  } catch {
    // not started
  }
}

const toggleDictation = (): void => {
  if (!available) return;
  if (mode === 'recording') {
    stopRecording(true);
  } else {
    setMode('recording');
  }
};

//////////
// INIT

if (micBtn && langSelect) {
  for (const [code, label] of LANGS) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    langSelect.append(option);
  }
  langSelect.value = defaultLang();
  if (listenToggle) listenToggle.checked = storage.get(LISTEN_KEY) === '1';

  // keep the options menu open while using its controls
  document.querySelector('#voiceInput .voice-menu')?.addEventListener('click', event => event.stopPropagation());

  micBtn.addEventListener('click', toggleDictation);
  stopBtn?.addEventListener('click', () => setMode('idle', true));
  document.addEventListener('keydown', event => {
    if (event.code === 'Space' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      toggleDictation();
    }
  });
  // TinyMCE runs in an iframe: listen there too
  const tinyEditor = tiny();
  if (tinyEditor) {
    tinyEditor.on('keydown', (event: KeyboardEvent) => {
      if (event.code === 'Space' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        toggleDictation();
      }
    });
  } else {
    // the editor may not be ready yet
    tinymce.on('AddEditor', event => {
      event.editor.on('keydown', (event: KeyboardEvent) => {
        if (event.code === 'Space' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          toggleDictation();
        }
      });
    });
  }

  langSelect.addEventListener('change', () => {
    storage.set(LANG_KEY, lang());
    const wasActive = mode;
    setMode('idle');
    void renderAvailability().then(() => {
      if (available && wasActive !== 'idle') setMode(wasActive);
    });
  });

  listenToggle?.addEventListener('change', () => {
    storage.set(LISTEN_KEY, listenToggle.checked ? '1' : '0');
    if (listenToggle.checked && mode === 'idle') setMode('listening');
    if (!listenToggle.checked && mode === 'listening') setMode('idle');
  });

  // the model download must be started from a click
  installBtn?.addEventListener('click', async () => {
    if (!Ctor) return;
    installBtn.disabled = true;
    if (modelStatus) modelStatus.textContent = t('voice-model-downloading', 'Downloading the speech model…');
    try {
      if (typeof Ctor.install === 'function') await Ctor.install({ langs: [lang()], processLocally: true });
      else if (typeof Ctor.installOnDevice === 'function') await Ctor.installOnDevice(lang());
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error));
    } finally {
      installBtn.disabled = false;
      void renderAvailability();
    }
  });

  // don't keep the microphone open for the wake word in a background tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'listening') {
      pausedForHidden = true;
      stopEngine();
    } else if (!document.hidden && pausedForHidden) {
      pausedForHidden = false;
      if (mode !== 'idle') startEngine();
    }
  });

  // save what was dictated before leaving
  window.addEventListener('beforeunload', () => {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      const entity = getEntity();
      void ApiC.patch(`${entity.type}/${entity.id}`, { body: getEditor().getContent(), notifOnSaved: 0, notifOnError: 0 }, { keepalive: true });
    }
  });

  void renderAvailability().then(() => {
    if (available && listenToggle?.checked) setMode('listening');
  });
}
