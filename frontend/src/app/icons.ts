// Small line icons, drawn in the text colour, and icon buttons that carry a tooltip.

import { h } from './dom';

const PATHS = {
  // A page with a folded corner: the whole file.
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  // A clock: history.
  history: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 4.5V8l2.5 1.5',
  // A circular arrow: fetch.
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3',
  // Arrows up and down: push and pull.
  push: 'M8 13.5v-11M4 6.5l4-4 4 4',
  pull: 'M8 2.5v11M4 9.5l4 4 4-4',
  // A box with an arrow leaving it: open elsewhere.
  external: 'M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4',
  // Chevrons for collapsing bars.
  left: 'M10 3.5 5.5 8l4.5 4.5',
  right: 'M6 3.5 10.5 8 6 12.5',
  plus: 'M8 3v10M3 8h10',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'svg-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}

/** A button showing an icon (and an optional label), with a tooltip. */
export function iconButton(name: IconName, tip: string, onclick: (e: MouseEvent) => void, opts: { label?: string; class?: string } = {}): HTMLButtonElement {
  return h('button', {
    class: `icon-btn ${opts.class ?? ''}`, 'data-tip': tip, 'aria-label': tip,
    onclick: (e: MouseEvent) => { e.stopPropagation(); onclick(e); },
  }, icon(name), opts.label ? h('span', { class: 'icon-label' }, opts.label) : null);
}
