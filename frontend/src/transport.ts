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

// The frontend's only way to talk to gako-core. Shaped for long-lived two-way streams (terminal
// bytes now, language servers later), not just request and response.

import type { Boot } from './boot';

export type Control =
  | { t: 'ack'; term: number; n: number }
  | { t: 'resize'; term: number; cols: number; rows: number }
  | { t: 'close'; term: number }
  | { t: 'log'; rec: Record<string, unknown> };

export interface TermStats {
  bytes: number;
  hash: number;
  pauses: number;
  maxUnacked: number;
}

export type CoreEvent =
  | { t: 'exit'; term: number; code: number | null; stats: TermStats }
  // The open workspace: a repo's status changed (or failed), the repo list changed, the first scan ended.
  | { t: 'repoStatus'; repo: string; status?: unknown; error?: string; ms: number }
  | { t: 'repoTouched'; repo: string }
  | { t: 'repos'; repos: unknown[] }
  | { t: 'filesChanged'; dirs: string[] }
  | { t: 'searchResults'; search: number; files: unknown[] }
  | { t: 'indexReady'; files: number; symbols: number; ms: number }
  | { t: 'scanDone'; ms: number; repos: number }
  // The settings file changed: its settings, or why it can't be read.
  | { t: 'settings'; settings?: unknown; error?: string };

/** Why the connection to the core ended (a WebSocket close event). Code 1006 is an end with no closing handshake. */
export interface CloseInfo {
  code: number;
  reason: string;
  clean: boolean;
}

export interface Transport {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  send(msg: Control): void;
  /** Terminal input. */
  sendBytes(term: number, data: Uint8Array): void;
  /** Terminal output for one terminal. Returns an unsubscribe function. */
  onBytes(term: number, fn: (data: Uint8Array) => void): () => void;
  onEvent(fn: (ev: CoreEvent) => void): () => void;
  /** Called when the connection is lost, as when macOS closes it while the screen sleeps. Requests
   * fail and input is dropped until it comes back; the transport keeps trying by itself. */
  onClose(fn: (info: CloseInfo) => void): () => void;
  /** Called when a lost connection is back. The core has forgotten everything tied to the old
   * one (the open workspace, a search under way), but not the terminals. */
  onReconnect(fn: () => void): () => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** How long to wait before trying to connect again, after the nth failure. */
const RETRY_MS = [100, 250, 500, 1000, 2000];

class WebSocketTransport implements Transport {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private bytes = new Map<number, (data: Uint8Array) => void>();
  private events = new Set<(ev: CoreEvent) => void>();
  private closers = new Set<(info: CloseInfo) => void>();
  private reconnectors = new Set<() => void>();

  constructor(private url: string, private ws: WebSocket) {
    this.adopt(ws);
  }

  private adopt(ws: WebSocket): void {
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => this.receive(e);
    ws.onclose = (e) => {
      // A socket that was already replaced says nothing new.
      if (ws !== this.ws) return;
      for (const p of this.pending.values()) p.reject(new Error('core connection closed'));
      this.pending.clear();
      const info = { code: e.code, reason: e.reason, clean: e.wasClean };
      for (const fn of this.closers) fn(info);
      this.reconnect(0);
    };
  }

  /** Connects again, as often as it takes: the page is still here, and so are its terminals. */
  private reconnect(failures: number): void {
    setTimeout(() => {
      const ws = new WebSocket(this.url);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.adopt(ws);
        for (const fn of this.reconnectors) fn();
      };
      // A failed attempt closes the socket too; that is what is waited for.
      ws.onclose = () => {
        if (!opened) this.reconnect(failures + 1);
      };
    }, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // Asking a core that is gone fails at once, instead of waiting for a reply that can't come.
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('core connection closed'));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ t: 'req', id, m: method, p: params ?? null }));
    });
  }

  send(msg: Control): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendBytes(term: number, data: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(4 + data.length);
    new DataView(frame.buffer).setUint32(0, term);
    frame.set(data, 4);
    this.ws.send(frame);
  }

  onBytes(term: number, fn: (data: Uint8Array) => void): () => void {
    this.bytes.set(term, fn);
    return () => this.bytes.delete(term);
  }

  onEvent(fn: (ev: CoreEvent) => void): () => void {
    this.events.add(fn);
    return () => this.events.delete(fn);
  }

  onClose(fn: (info: CloseInfo) => void): () => void {
    this.closers.add(fn);
    return () => this.closers.delete(fn);
  }

  onReconnect(fn: () => void): () => void {
    this.reconnectors.add(fn);
    return () => this.reconnectors.delete(fn);
  }

  private receive(e: MessageEvent): void {
    if (e.data instanceof ArrayBuffer) {
      const term = new DataView(e.data).getUint32(0);
      this.bytes.get(term)?.(new Uint8Array(e.data, 4));
      return;
    }
    const msg = JSON.parse(e.data as string);
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.e !== undefined) p.reject(new Error(msg.e));
      else p.resolve(msg.r);
    } else {
      for (const fn of this.events) fn(msg as CoreEvent);
    }
  }
}

export function connect(b: Boot): Promise<Transport> {
  const url = `${b.url}/?token=${encodeURIComponent(b.token)}`;
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(new WebSocketTransport(url, ws));
    ws.onerror = () => reject(new Error(`cannot connect to gako-core at ${b.url}`));
  });
}
