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

// Files shown as they are rather than as text: images Chromium draws, and PDFs, which its own
// viewer shows. Known by extension, and the type given to the browser is the one named here, never
// guessed from the content: a file called .png that holds a web page is shown as an image, and
// fails as one. SVG is text, and is read as text.

export type MediaKind = 'image' | 'pdf';

export interface MediaType {
  kind: MediaKind;
  mime: string;
  /** What to call it: PNG, JPEG, PDF… */
  label: string;
}

const TYPES: Record<string, MediaType> = {
  png: { kind: 'image', mime: 'image/png', label: 'PNG' },
  jpg: { kind: 'image', mime: 'image/jpeg', label: 'JPEG' },
  jpeg: { kind: 'image', mime: 'image/jpeg', label: 'JPEG' },
  gif: { kind: 'image', mime: 'image/gif', label: 'GIF' },
  webp: { kind: 'image', mime: 'image/webp', label: 'WebP' },
  avif: { kind: 'image', mime: 'image/avif', label: 'AVIF' },
  bmp: { kind: 'image', mime: 'image/bmp', label: 'BMP' },
  ico: { kind: 'image', mime: 'image/x-icon', label: 'ICO' },
  pdf: { kind: 'pdf', mime: 'application/pdf', label: 'PDF' },
};

/** The media type of a path, by its extension; null for anything shown as text. */
export function mediaType(path: string): MediaType | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

/** A size for people: 912 bytes, 252 KB, 3.1 MB. */
export function byteSize(n: number): string {
  if (n < 1024) return `${n.toLocaleString()} byte${n === 1 ? '' : 's'}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024).toLocaleString()} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
