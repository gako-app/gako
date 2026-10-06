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
