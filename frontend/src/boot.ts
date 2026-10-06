// The one place that knows which shell the frontend runs in. It only finds out how to reach
// gako-core; everything else goes through the Transport.
//
// - Tauri injects `window.__GAKO_BOOT__` with an initialization script.
// - Electron exposes `window.__GAKO_BOOT__` from its preload script.
// - In a plain browser (development), pass `?core=ws://127.0.0.1:PORT&token=TOKEN`.

export interface Boot {
  url: string;
  token: string;
  shell: string;
}

declare global {
  interface Window {
    __GAKO_BOOT__?: Boot;
  }
}

export function boot(): Boot {
  if (window.__GAKO_BOOT__) return window.__GAKO_BOOT__;
  const q = new URLSearchParams(location.search);
  const url = q.get('core');
  const token = q.get('token');
  if (!url || !token) {
    throw new Error('No core address: start Gako from a shell, or open with ?core=ws://…&token=…');
  }
  return { url, token, shell: 'browser' };
}
