// The one place that knows which shell the frontend runs in. It finds out how to reach gako-core,
// and whether the shell offers a native folder picker; everything else goes through the Transport.
//
// - Tauri injects `window.__GAKO_BOOT__` with an initialization script.
// - Electron exposes `window.__GAKO_BOOT__` and `window.__GAKO_SHELL__` from its preload script.
// - In a plain browser (development), pass `?core=ws://127.0.0.1:PORT&token=TOKEN`. There's no
//   folder picker there: folders are opened by typing their path.

export interface Boot {
  url: string;
  token: string;
  shell: string;
  /** The shell's native folder picker, if it has one: the folder chosen, or null if cancelled. */
  pickFolder?: (defaultPath?: string) => Promise<string | null>;
}

declare global {
  interface Window {
    __GAKO_BOOT__?: Boot;
    __GAKO_SHELL__?: { pickFolder?: Boot['pickFolder'] };
  }
}

export function boot(): Boot {
  if (window.__GAKO_BOOT__) return { ...window.__GAKO_BOOT__, pickFolder: window.__GAKO_SHELL__?.pickFolder };
  const q = new URLSearchParams(location.search);
  const url = q.get('core');
  const token = q.get('token');
  if (!url || !token) {
    throw new Error('No core address: start Gako from a shell, or open with ?core=ws://…&token=…');
  }
  return { url, token, shell: 'browser' };
}
