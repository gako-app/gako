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
