/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

/**
 * Voice commands of the main text dictation (voice-input.ts), kept free of DOM code so it can be tested alone.
 * "Alo" starts recording, "Alo stop" stops it. Recognizers write it allô, allo, alo, hallo or halo.
 */

// wake word, optionally followed by a stop word; surrounding punctuation is part of the command
// (?<!\p{L}) / (?!\p{L}) instead of \b: \b doesn't work next to accented letters like ô
export const COMMAND_RE = /[\s,;:]*(?<!\p{L})(?:all?[oô]|hall?o|halo)(?!\p{L})(?:[\s,.!?;:]*(stop(?:p|pe|ped|s)?|arr[eê]te?)(?!\p{L}))?[\s,.!?;:]*/giu;

export type VoiceCommand = 'start' | 'stop';
export type CommandPart = { text: string } | { command: VoiceCommand };

// split a transcript in text and commands, in order
export function parseCommands(transcript: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let cursor = 0;
  for (const match of transcript.matchAll(COMMAND_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: transcript.slice(cursor, index) });
    parts.push({ command: match[1] === undefined ? 'start' : 'stop' });
    cursor = index + match[0].length;
  }
  if (cursor < transcript.length) parts.push({ text: transcript.slice(cursor) });
  return parts;
}

// the transcript without any command, e.g. for the interim display
export const stripCommands = (transcript: string): string => transcript.replace(COMMAND_RE, ' ').replace(/\s+/g, ' ').trim();
