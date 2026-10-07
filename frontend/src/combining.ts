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

// Drops pathological runs of combining marks from terminal output.
//
// Long runs of combining marks on one character ("zalgo" text) cost memory twice: xterm.js stores
// a character's marks as a growing string on its cell, and the WebGL renderer caches every distinct
// stack of marks as its own glyph, in the GPU process. Both were measured (see docs/terminals.md):
// cutting runs to 8 marks still let the GPU process grow to 8 GB on a dump of random stacks, while
// keeping at most one mark held it near 100 MB. Real writing stays within 4 marks per character
// (Vietnamese, Thai, Hebrew with points, Indic scripts), so a run longer than that is dropped whole,
// keeping the base character: what's left can't create unbounded glyph variety.

const MARK = /^\p{M}$/u;

export class CombiningCap {
  private decoder = new TextDecoder();
  /** Marks at the end of the previous chunk, held back: the run may continue past the limit. */
  private held = '';
  private heldCount = 0;
  /** The current run is already too long: drop marks until it ends. */
  private overflow = false;
  private longRun: RegExp;
  private max: number;

  constructor(max: number) {
    this.max = max;
    this.longRun = new RegExp(`\\p{M}{${max + 1},}`, 'gu');
  }

  /** Decodes a chunk of UTF-8 output (split sequences are carried over) and drops long runs. */
  apply(bytes: Uint8Array): string {
    let s = this.decoder.decode(bytes, { stream: true });
    if (!s) return s;
    let out = '';
    if (this.heldCount || this.overflow) {
      const lead = /^\p{M}+/u.exec(s)?.[0] ?? '';
      const n = Array.from(lead).length;
      if (lead.length === s.length) {
        this.absorb(lead, n);
        return '';
      }
      if (!this.overflow && this.heldCount + n <= this.max) out += this.held + lead;
      this.held = '';
      this.heldCount = 0;
      this.overflow = false;
      s = s.slice(lead.length);
    }
    const [tail, count] = trailingMarks(s);
    out += s.slice(0, s.length - tail.length).replace(this.longRun, '');
    if (count) this.absorb(tail, count);
    return out;
  }

  /** Marks held back at the end of the output so far: the run may yet continue. */
  get holding(): boolean {
    return this.heldCount > 0;
  }

  /** Writes out held marks once no more output is coming (the run turned out short). */
  flush(): string {
    const out = this.held;
    this.held = '';
    this.heldCount = 0;
    return out;
  }

  private absorb(marks: string, n: number): void {
    if (this.overflow) return;
    if (this.heldCount + n > this.max) {
      this.overflow = true;
      this.held = '';
      this.heldCount = 0;
    } else {
      this.held += marks;
      this.heldCount += n;
    }
  }
}

/** The same rule over a whole string (for checking expected output). */
export function capCombining(text: string, max: number): string {
  return max ? text.replace(new RegExp(`\\p{M}{${max + 1},}`, 'gu'), '') : text;
}

/** The run of marks at the end of `s`, and how many marks it holds. */
function trailingMarks(s: string): [string, number] {
  let n = 0;
  let i = s.length;
  while (i > 0) {
    const cp = s.codePointAt(i - 1)!;
    const len = cp >= 0xdc00 && cp <= 0xdfff && i > 1 ? 2 : 1;
    if (!MARK.test(s.slice(i - len, i))) break;
    n++;
    i -= len;
  }
  return [s.slice(i), n];
}
