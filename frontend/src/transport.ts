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

export type CoreEvent = { t: 'exit'; term: number; code: number | null; stats: TermStats };

export interface Transport {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  send(msg: Control): void;
  /** Terminal input. */
  sendBytes(term: number, data: Uint8Array): void;
  /** Terminal output for one terminal. Returns an unsubscribe function. */
  onBytes(term: number, fn: (data: Uint8Array) => void): () => void;
  onEvent(fn: (ev: CoreEvent) => void): () => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class WebSocketTransport implements Transport {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private bytes = new Map<number, (data: Uint8Array) => void>();
  private events = new Set<(ev: CoreEvent) => void>();

  constructor(private ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => this.receive(e);
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('core connection closed'));
      this.pending.clear();
    };
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ t: 'req', id, m: method, p: params ?? null }));
    });
  }

  send(msg: Control): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendBytes(term: number, data: Uint8Array): void {
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
  const ws = new WebSocket(`${b.url}/?token=${encodeURIComponent(b.token)}`);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(new WebSocketTransport(ws));
    ws.onerror = () => reject(new Error(`cannot connect to gako-core at ${b.url}`));
  });
}
