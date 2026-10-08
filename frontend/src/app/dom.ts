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

// A tiny DOM builder: h('div', { class: 'row', onclick }, child, 'text').

type Attrs = Record<string, unknown>;
type Child = Node | string | number | false | null | undefined | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/** Replaces an element's children; like replaceChildren, but skipping null and false. */
export function fill(el: HTMLElement, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Covers `el` with a still copy of how it looks now, until the returned function is called: what
 * a view shows can then be replaced underneath without its in-between states being seen. The copy
 * is a clone of its elements, with the pictures in its 2D canvases (Monaco's rulers and minimap),
 * the state of its form fields (a clone keeps a select's first option) and its scroll positions
 * copied over. */
export function freeze(el: HTMLElement): () => void {
  const rect = el.getBoundingClientRect();
  if (!el.isConnected || !rect.width || !rect.height || getComputedStyle(el).visibility === 'hidden') return () => {};
  const copy = el.cloneNode(true) as HTMLElement;
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  copy.classList.add('frozen');
  Object.assign(copy.style, {
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    margin: '0', zIndex: '50', pointerEvents: 'none',
  });
  document.body.append(copy);
  const from = el.querySelectorAll('*');
  const to = copy.querySelectorAll('*');
  from.forEach((src, i) => {
    const dst = to[i];
    if (src.scrollTop || src.scrollLeft) {
      dst.scrollTop = src.scrollTop;
      dst.scrollLeft = src.scrollLeft;
    }
    if (src instanceof HTMLSelectElement && dst instanceof HTMLSelectElement) dst.selectedIndex = src.selectedIndex;
    else if (src instanceof HTMLInputElement && dst instanceof HTMLInputElement) {
      dst.value = src.value;
      dst.checked = src.checked;
    } else if (src instanceof HTMLTextAreaElement && dst instanceof HTMLTextAreaElement) dst.value = src.value;
    if (src instanceof HTMLCanvasElement && dst instanceof HTMLCanvasElement && src.width && src.height) {
      try { dst.getContext('2d')?.drawImage(src, 0, 0); } catch { /* a WebGL canvas: left blank */ }
    }
  });
  return () => copy.remove();
}

/** Resolves once `el` has gone a whole animation frame without changing (Monaco often draws in more
 * than one frame), or after `maxMs` in any case. */
export function settled(el: HTMLElement, maxMs = 120): Promise<void> {
  return new Promise((resolve) => {
    // Changes are noted as they happen; each frame's check runs after the frame's other callbacks
    // (Monaco's drawing, scheduled earlier), so a frame that drew something is seen as changed.
    let changed = false;
    const observer = new MutationObserver(() => { changed = true; });
    observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, maxMs);
    const frame = () => {
      if (!changed) return done();
      changed = false;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** Resolves after `ms`. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function relativeTime(epochSeconds: number): string {
  const s = Date.now() / 1000 - epochSeconds;
  const units: [number, string][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month']];
  let v = s;
  for (const [n, name] of units) {
    if (v < n) return `${Math.max(1, Math.floor(v))} ${name}${Math.floor(v) === 1 ? '' : 's'} ago`;
    v /= n;
  }
  return `${Math.floor(v)} year${Math.floor(v) === 1 ? '' : 's'} ago`;
}
