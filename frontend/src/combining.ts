// Caps runs of combining marks in terminal output.
//
// xterm.js stores a character's combining marks as a growing string on its cell, so a long run (a
// dump of "zalgo" text, say) makes a tab's memory grow with the amount of output, not just with its
// scrollback; the WebGL renderer adds a glyph per distinct stack. Real text stays far below 8 marks
// per character, so cutting longer runs loses nothing readable. See docs/PHASE2.md.

const MARK = /^\p{M}$/u;

export class CombiningCap {
  private decoder = new TextDecoder();
  private trailing = 0;
  private run: RegExp;
  private max: number;

  constructor(max: number) {
    this.max = max;
    this.run = new RegExp(`(\\p{M}{${max}})\\p{M}+`, 'gu');
  }

  /** Decodes a chunk of UTF-8 output (split sequences are carried over) and caps its runs. */
  apply(bytes: Uint8Array): string {
    let s = this.decoder.decode(bytes, { stream: true });
    if (!s) return s;
    // A run that started in an earlier chunk keeps counting.
    if (this.trailing) {
      const lead = /^\p{M}+/u.exec(s);
      if (lead) {
        const marks = Array.from(lead[0]);
        const keep = marks.slice(0, Math.max(0, this.max - this.trailing)).join('');
        if (lead[0].length === s.length) {
          this.trailing += marks.length;
          return keep;
        }
        s = keep + s.slice(lead[0].length);
      }
    }
    s = s.replace(this.run, '$1');
    this.trailing = trailingMarks(s);
    return s;
  }
}

/** Caps a whole string at once (for checking expected output). */
export function capCombining(text: string, max: number): string {
  return max ? text.replace(new RegExp(`(\\p{M}{${max}})\\p{M}+`, 'gu'), '$1') : text;
}

function trailingMarks(s: string): number {
  let n = 0;
  let i = s.length;
  while (i > 0) {
    const cp = s.codePointAt(i - 1)!;
    const len = cp >= 0xdc00 && cp <= 0xdfff && i > 1 ? 2 : 1;
    if (!MARK.test(s.slice(i - len, i))) break;
    n++;
    i -= len;
  }
  return n;
}
