// What an agent's terminal title says about its state. Some agents title their terminal with a
// spinner while they work and change it when they stop; that is a better signal than output
// alone, which a blinking prompt or a redraw keeps alive. Recorded on 2026-10-06 (PHASE2.md):
//
//   Claude Code  "◐ Fix the tests" while working, "✳ Fix the tests" otherwise
//   Codex        "⠦ Fix tests | repo" while working, "[ ! ] Action Required | Fix tests | repo"
//                (blinking with "[ . ]") while it waits for approval, "Fix tests | repo" when idle
//   OpenCode, Pi a fixed title: nothing to read

/** What a title says: working, waiting for the user, or neither (no spinner). */
export type TitleState = 'working' | 'waiting' | 'idle';

// Braille spinner frames (Codex and many CLIs) and the quarter circles Claude Code uses.
const SPINNER = /^[⠀-⣿◐◓◑◒]\s/;
const WAITING = /^\[ [.!] \] Action Required\b/;
// Markers that only say "not working": Claude Code's star.
const IDLE_MARK = /^✳\s/;

export function readTitle(title: string): TitleState {
  if (WAITING.test(title)) return 'waiting';
  if (SPINNER.test(title)) return 'working';
  return 'idle';
}

/** Whether a title is one of the state-bearing kinds, so its absence of a spinner means "stopped". */
export function titleHasState(title: string): boolean {
  return WAITING.test(title) || SPINNER.test(title) || IDLE_MARK.test(title);
}

/** The title without its state markers: what the agent is on, for showing next to its name. */
export function titleTopic(title: string): string {
  let t = title.replace(WAITING, '').replace(/^\s*\|\s*/, '');
  // Codex can stack two spinner frames ("⠏ ⠏ | repo").
  while (SPINNER.test(t) || IDLE_MARK.test(t)) t = t.replace(SPINNER, '').replace(IDLE_MARK, '').replace(/^\s*\|\s*/, '');
  return t.trim();
}

// Desktop notifications an agent sends through the terminal: OSC 9 (iTerm2's), OSC 777 (rxvt's
// `notify`) and OSC 99 (kitty's, which OpenCode asks about before using). Gako doesn't raise system
// notifications; a notification marks the agent as wanting the user, with its text.

/** What to do with an OSC sequence: reply to the program, or show a notice. */
export type OscAction = { reply: string } | { notice: string } | null;

/** Reassembles notifications sent in parts (kitty's `d=0`), per terminal. */
export class Notifications {
  private pending = new Map<string, string[]>();

  handle(code: number, data: string): OscAction {
    if (code === 9) {
      // `9;4;…` is ConEmu's progress report, not a notification.
      return /^4;/.test(data) || !data.trim() ? null : { notice: data.trim() };
    }
    if (code === 777) {
      const [kind, title = '', body = ''] = data.split(';');
      return kind === 'notify' ? { notice: [title, body].filter(Boolean).join(': ') } : null;
    }
    if (code !== 99) return null;
    const semi = data.indexOf(';');
    if (semi < 0) return null;
    const meta = new Map(data.slice(0, semi).split(':').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)] as [string, string];
    }));
    const id = meta.get('i') ?? '';
    const part = meta.get('p') ?? 'title';
    if (part === '?') {
      // What Gako takes: a title and a body, whether or not the window has focus.
      return { reply: `\x1b]99;i=${id}:p=?;p=title,body:o=always,unfocused:u=0,1,2\x1b\\` };
    }
    let payload = data.slice(semi + 1);
    if (meta.get('e') === '1') {
      try { payload = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))); } catch { payload = ''; }
    }
    if (part !== 'title' && part !== 'body') return null;
    const parts = this.pending.get(id) ?? [];
    if (payload) parts.push(payload);
    if (meta.get('d') === '0') {
      this.pending.set(id, parts);
      return null;
    }
    this.pending.delete(id);
    return parts.length ? { notice: parts.join(': ') } : null;
  }
}
