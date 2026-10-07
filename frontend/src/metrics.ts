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

// Timing records: written to the core's log (JSON lines, read by bench/measure) and shown in a
// small overlay.

import type { Transport } from './transport';

export class Metrics {
  private overlay = document.getElementById('overlay')!;
  private shown = new Map<string, string>();

  constructor(
    private t: Transport,
    private context: Record<string, unknown>,
  ) {}

  log(ev: string, data: Record<string, unknown> = {}): void {
    const rec = { ev, epochMs: performance.timeOrigin + performance.now(), ...this.context, ...data };
    this.t.send({ t: 'log', rec });
  }

  /** Shows one line in the overlay, replacing the previous line with the same key. */
  show(key: string, text: string): void {
    this.shown.set(key, text);
    this.overlay.textContent = [...this.shown].map(([k, v]) => `${k}: ${v}`).join('\n');
  }
}

export interface Summary {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

export function summarize(values: number[]): Summary {
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? NaN;
  return {
    n: v.length,
    min: v[0] ?? NaN,
    median: at(0.5),
    p95: at(0.95),
    max: v[v.length - 1] ?? NaN,
    mean: v.reduce((a, b) => a + b, 0) / (v.length || 1),
  };
}

export const ms = (x: number) => `${x.toFixed(1)} ms`;

export function frames(n = 1): Promise<void> {
  return new Promise((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
