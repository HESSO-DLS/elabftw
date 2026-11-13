# HES-SO DLS eLabFTW — release notes of the fork

This fork of [eLabFTW](https://github.com/elabftw/elabftw) (branch `excalidraw`) runs as the image
`elabftw-custom/elabimg:<eLabFTW version>-excalidraw.<build>`. Upstream changes are listed on the
[eLabFTW releases page](https://github.com/elabftw/elabftw/releases).

## 6.0.6-excalidraw.11 — 2026-11-13

### Voice input: "Hello" works too
English speech recognition writes "Alo" as *hello*: **"Hello"** / **"Hello stop"** (and *hallo*, *helo*,
*hullo*) now work like "Alo" / "Alo stop". Note that a dictated "hello" now starts or stops the recording
and isn't written in the text.

## 6.0.6-excalidraw.10 — 2026-11-13

### Instrument logbook: logbook view, alerts and instrument status
- **Logbook section on the instrument page.** Instruments with the "Logbook required" checkbox now have a
  *Logbook* section at the top of their page:
  - a banner with the latest reported status, who reported it and when;
  - a table of all entries you can read: date, user, linked experiment, status and the template fields
    (column, mobile phase, flow rate, pressure, cleaning…);
  - filters by status (all / needs attention / ready) and by text;
  - **Export CSV** (one column per field, opens in Excel), **Show in experiments list** and **New entry**.
- **Email alerts.** When a logbook entry reports that the instrument is not ready (e.g. *Maintenance needed*
  or *Out of service*), the instrument stewards receive a notification and an email (sent within a minute).
  Stewards are the people chosen in a custom field of type *Users* whose name contains "steward" on the
  instrument (e.g. *Instrument steward*). Without stewards, the organization administrators are alerted.
  Changing the status of an entry again to the same value doesn't send a new alert.
- **The instrument status follows the logbook.** The resource status of the instrument is set to the status
  reported by its most recent logbook entry (*Ready*, *Maintenance needed*, *Out of service*), so it shows in
  resource lists. Missing statuses are created automatically (green, orange, red).
  Editing an older entry doesn't change the instrument status.

How the status is found: the first *dropdown* field of the logbook template whose name contains "status";
its **first option means ready**.

### Voice input: new command "Alo"
"LabNote" was poorly recognized. Say **"Alo"** to start dictating and **"Alo stop"** to stop
(*allô*, *allo*, *hallo*, *halo* and *arrête* are understood too). In listen mode, the editor waits for "Alo".
Words like *halogen* or *allosteric* don't trigger it.

### Setup after the update (administrators)
1. On each instrument with "Logbook required", add a custom field of type **Users** named
   **Instrument steward** and choose the steward(s).
2. Nothing else: statuses are created on the first logbook entry.

## 6.0.6-excalidraw.9 — 2026-11-13

### Whiteboard keeps saving when it stays open for hours
- After a cancelled "leave this page?" prompt, saves of the whiteboard failed until the page was reloaded:
  fixed.
- A save that never gets an answer (laptop sleep, network change) no longer blocks the next ones.
- If the whiteboard editor reloads by itself, it reconnects and gets its drawing back.
- If the server session is lost (e.g. after a server restart), you are logged in again in the background
  with "Remember me" and the save goes through. Without it, the drawing is kept in your browser and offered
  back (**Restore it** / **Discard**) after you log in again.

### Instrument logbook entry when an instrument is linked
- Instruments (resources) with a "Logbook required" checkbox field need a logbook entry for each use. A
  logbook entry is an experiment created from an experiment template linked to the instrument
  (e.g. *HPLC 78860 – log –*), see [elabftw#6023](https://github.com/elabftw/elabftw/issues/6023).
- When you link such an instrument to an experiment, a short form opens with the template fields (groups,
  units, required fields) and an *Observations / issues* box. **Save logbook entry** creates the entry,
  linked to the instrument and to your experiment. **Later** closes it, **Open the full entry instead** opens
  the complete entry.
- Linked instruments show a **Logbook missing** or **Logbook** badge.

### Voice input in the main text
- A microphone button next to the main text options (or Ctrl+Shift+Space) starts and stops dictation, in the
  rich text and markdown editors, at the cursor. Say "new line" or "new paragraph" to break lines.
- Listen mode waits for the voice command to start dictating (see .10 for the command).
- **Speech is recognized on your computer only, audio is never sent to a server.** This needs Chrome 139 or
  newer; download the speech model once from the menu next to the microphone. In other browsers the button
  is disabled.

## Earlier builds (6.0.6-excalidraw.3 – .8, October 2026)
- One autosaved **whiteboard** (Excalidraw) per experiment, resource and template, right under the main text;
  read-only when the entry is locked. The old "Draw something" canvas is only kept to annotate images.
- Wording: *team* → **organization**, *user group* → **project team** (English, French, German).
- Security rebuild for PHP2Shell (PHP 8.4.27).
