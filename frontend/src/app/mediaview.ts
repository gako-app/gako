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

// Showing an image or a PDF from the core's base64 content: an image on a checkerboard, fitted to
// the view until clicked for its actual size; a PDF in Chromium's own viewer, from an in-memory
// blob of the stated type. Both the viewer and the diff panel use it.

import type { FileContent } from './model';
import { byteSize, type MediaType } from './media';
import { h } from './dom';

export interface MediaView {
  el: HTMLElement;
  /** Releases the PDF's in-memory copy. */
  dispose(): void;
}

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  const s = atob(base64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The view of one file, or of a message where it can't be shown. */
export function mediaView(content: FileContent | null, type: MediaType, missing = 'Not here.'): MediaView {
  const none = (text: string) => ({ el: h('div', { class: 'media-empty dim' }, text), dispose: () => {} });
  if (!content) return none(missing);
  if (!content.base64) return none(`Too large to show (${byteSize(content.size)}).`);
  const info = h('div', { class: 'media-info dim' }, `${type.label} · ${byteSize(content.size)}`);
  if (type.kind === 'image') {
    const img = h('img', { src: `data:${type.mime};base64,${content.base64}`, alt: '', draggable: false });
    const stage = h('div', { class: 'media-stage fit', 'data-tip': 'Click for the actual size' }, img);
    stage.addEventListener('click', () => {
      const fit = stage.classList.toggle('fit');
      stage.dataset.tip = fit ? 'Click for the actual size' : 'Click to fit';
    });
    img.addEventListener('load', () => {
      info.textContent = `${type.label} · ${img.naturalWidth.toLocaleString()} × ${img.naturalHeight.toLocaleString()} · ${byteSize(content.size)}`;
    });
    img.addEventListener('error', () => stage.replaceChildren(h('div', { class: 'media-empty dim' }, `Not a ${type.label} image Chromium can show.`)));
    return { el: h('div', { class: 'media' }, stage, info), dispose: () => {} };
  }
  const url = URL.createObjectURL(new Blob([bytes(content.base64)], { type: type.mime }));
  const frame = h('iframe', { class: 'media-pdf', src: url, title: 'PDF' });
  return { el: h('div', { class: 'media' }, frame, info), dispose: () => URL.revokeObjectURL(url) };
}
