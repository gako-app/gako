// Gako: a workspace app for reviewing and supervising coding agents across many repositories.
// Copyright (C) 2026 João Sena Ribeiro
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU Affero General Public License as published by the Free Software Foundation, either version 3
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along with this program.
// If not, see <https://www.gnu.org/licenses/>.

// Integrity checks: was anything lost or garbled between the PTY and the screen?
//
// Two independent checks. The transport check compares a hash of every byte the frontend received
// with the hash the core computed over every byte it read from the PTY. The buffer check reads
// xterm.js's buffer afterwards and validates the fixtures' self-checking lines (`<seq> … #<crc32>`).

import type { IBufferLine, Terminal } from '@xterm/xterm';

export const FNV_OFFSET = 0x811c9dc5;

/** FNV-1a, 32 bit; the core computes the same over the bytes it forwards. */
export function fnv1a(hash: number, data: Uint8Array): number {
  let h = hash | 0;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const utf8 = new TextEncoder();

export function crc32(text: string): number {
  let c = ~0;
  for (const b of utf8.encode(text)) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function rowText(line: IBufferLine, cols: number, continues: boolean): string {
  if (!continues) return line.translateToString(true);
  // A wrapped row is full, except for a blank cell left when a wide character didn't fit.
  const text = line.translateToString(false);
  const last = line.getCell(cols - 1);
  return last && last.getChars() === '' && last.getWidth() === 1 ? text.slice(0, -1) : text;
}

export interface Lines {
  lines: string[];
  /** The first line started before the oldest row still in the scrollback. */
  firstPartial: boolean;
}

/** The buffer (scrollback and screen) as logical lines, with wrapped rows joined. */
export function logicalLines(term: Terminal): Lines {
  const buf = term.buffer.active;
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)!;
    const next = buf.getLine(i + 1);
    const text = rowText(line, term.cols, !!next?.isWrapped);
    if (i > 0 && !line.isWrapped) {
      lines.push(current);
      current = '';
    }
    current += text;
  }
  lines.push(current);
  return { lines, firstPartial: !!buf.getLine(0)?.isWrapped };
}

export interface SeqCheck {
  ok: boolean;
  checked: number;
  badCrc: number;
  gaps: number;
  firstSeq: number | null;
  lastSeq: number | null;
  expectedLastSeq: number;
  trailerFound?: boolean;
  examples: string[];
}

/** Validates self-checking lines of the form `<seq> <text> #<crc32 of "<seq> <text>">`. */
export function checkSeqLines({ lines, firstPartial }: Lines, digits: number, expectedLastSeq: number, trailer?: string): SeqCheck {
  const re = new RegExp(`^(\\d{${digits}}) (.*) #([0-9a-f]{8})$`);
  const r: SeqCheck = {
    ok: false, checked: 0, badCrc: 0, gaps: 0, firstSeq: null, lastSeq: null, expectedLastSeq, examples: [],
  };
  let prev: number | null = null;
  for (const line of firstPartial ? lines.slice(1) : lines) {
    const m = re.exec(line);
    if (!m) continue;
    const seq = Number(m[1]);
    r.checked++;
    if (crc32(`${m[1]} ${m[2]}`) !== parseInt(m[3], 16)) {
      r.badCrc++;
      if (r.examples.length < 3) r.examples.push(line.slice(0, 300));
    }
    if (prev !== null && seq !== prev + 1) r.gaps++;
    r.firstSeq ??= seq;
    r.lastSeq = seq;
    prev = seq;
  }
  if (trailer !== undefined) r.trailerFound = lines.some((l) => l === trailer);
  r.ok = r.checked > 0 && r.badCrc === 0 && r.gaps === 0 && r.lastSeq === expectedLastSeq && r.trailerFound !== false;
  return r;
}

export interface TailCheck {
  ok: boolean;
  trailerFound: boolean;
  compared: number;
  mismatchAt: number | null;
}

/** The logical line before the trailer must end with `tail` (as much of it as the buffer holds). */
export function checkTail({ lines }: Lines, tail: string, trailer: string): TailCheck {
  const i = lines.lastIndexOf(trailer);
  if (i < 1) return { ok: false, trailerFound: i >= 0, compared: 0, mismatchAt: null };
  const got = lines[i - 1];
  const n = Math.min(got.length, tail.length);
  const a = got.slice(got.length - n);
  const b = tail.slice(tail.length - n);
  let mismatchAt: number | null = null;
  if (a !== b) {
    mismatchAt = 0;
    while (a[mismatchAt] === b[mismatchAt]) mismatchAt++;
  }
  return { ok: mismatchAt === null && n > 0, trailerFound: true, compared: n, mismatchAt };
}

/** The last `rows` rows of the screen, trimmed. */
export function screenTail(term: Terminal, rows: number): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = term.rows - rows; y < term.rows; y++) {
    out.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '');
  }
  return out;
}
