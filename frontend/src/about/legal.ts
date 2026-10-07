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

// The texts the About window shows, from plain text into parts it can lay out: the GNU licence's
// text (headings, numbered sections, lettered items, paragraphs), and THIRD-PARTY-NOTICES.txt as
// shells/electron/scripts/notices.mjs writes it. No DOM here, so the tests run these directly.

export type LicenceBlock =
  /** The centred title lines at the top. */
  | { kind: 'title'; lines: string[] }
  /** Lines whose breaks matter: the copyright under the title, the sample notices at the end. */
  | { kind: 'lines'; lines: string[] }
  /** A centred heading: Preamble, TERMS AND CONDITIONS, … */
  | { kind: 'heading'; text: string }
  /** A numbered section's title: "0. Definitions." */
  | { kind: 'section'; number: string; title: string }
  /** A lettered item: "a) The work must carry prominent notices…" */
  | { kind: 'item'; label: string; text: string }
  | { kind: 'para'; text: string };

const indent = (line: string) => line.length - line.trimStart().length;
const joined = (lines: string[]) => lines.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');

export function parseLicence(text: string): LicenceBlock[] {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
    .map((b) => b.replace(/^\n+|\s+$/g, '').split('\n'))
    .filter((lines) => lines.some((l) => l.trim()));
  return blocks.map((lines, i): LicenceBlock => {
    const section = lines.length === 1 ? /^\s*(\d+)\.\s+(.+?)\.?$/.exec(lines[0]) : null;
    const item = /^\s{3,}([a-z])\)\s+/.exec(lines[0]);
    if (i === 0) return { kind: 'title', lines: lines.map((l) => l.trim()) };
    if (lines.length === 1 && indent(lines[0]) >= 8) return { kind: 'heading', text: lines[0].trim() };
    if (section) return { kind: 'section', number: section[1], title: section[2] };
    if (item) return { kind: 'item', label: item[1], text: joined([lines[0].slice(item[0].length), ...lines.slice(1)]) };
    // Every line indented the same, and further than a paragraph's first line: lines kept as they are.
    if (lines.every((l) => indent(l) === indent(lines[0]) && indent(l) !== 2)) return { kind: 'lines', lines: lines.map((l) => l.trim()) };
    return { kind: 'para', text: joined(lines) };
  });
}

export interface NoticeText {
  file: string;
  text: string;
  /** Set when the notices file gave this text once, under another package: "name version". */
  sameAs?: string;
}

export interface NoticePackage {
  name: string;
  version: string;
  licence: string;
  source?: string;
  /** The heading the notices file lists it under: "npm packages" or "Rust crates". */
  group: string;
  texts: NoticeText[];
}

// notices.mjs's rules are 78 wide; licence texts have rules of their own, so a rule only counts
// where what follows has the right shape too.
const RULE = (c: string) => new RegExp(`^${c}{78}$`);

export function parseNotices(text: string): NoticePackage[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const packages: NoticePackage[] = [];
  let group = '';
  let pkg: NoticePackage | null = null;
  let current: NoticeText | null = null;
  const shared: { t: NoticeText; file: string }[] = [];
  const end = () => {
    if (current) current.text = current.text.replace(/^\n+|\s+$/g, '');
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ===== / heading / =====: a group.
    if (RULE('=').test(line) && RULE('=').test(lines[i + 2] ?? '')) {
      end();
      pkg = null;
      group = lines[i + 1].trim();
      i += 2;
      continue;
    }
    // ----- then "name version", "Licence: …" and maybe "Source: …": a package.
    if (RULE('-').test(line) && group && /^Licence: /.test(lines[i + 2] ?? '')) {
      end();
      const [name, version = ''] = (lines[++i] ?? '').trim().split(/ (?=\S+$)/);
      pkg = { name, version, licence: '', group, texts: [] };
      packages.push(pkg);
      for (let m; (m = /^(Licence|Source): (.*)$/.exec(lines[i + 1] ?? '')); i++) {
        if (m[1] === 'Licence') pkg.licence = m[2];
        else pkg.source = m[2];
      }
      continue;
    }
    // --- FILE --- starts a licence text; --- FILE: the same text as NAME VERSION's FILE, above ---
    // points to one given before.
    const head = /^--- (.+) ---$/.exec(line);
    if (head && pkg) {
      end();
      const same = /^(.+?): the same text as (.+)'s (\S+), above$/.exec(head[1]);
      const t: NoticeText = same ? { file: same[1], text: '', sameAs: same[2] } : { file: head[1], text: '' };
      pkg.texts.push(t);
      if (same) shared.push({ t, file: same[3] });
      else current = t;
      continue;
    }
    if (current) (current as NoticeText).text += `${line}\n`;
  }
  end();
  // Fill in the shared texts from the package that gave them.
  const byId = new Map(packages.map((p) => [`${p.name} ${p.version}`, p]));
  for (const { t, file } of shared) t.text = byId.get(t.sameAs!)?.texts.find((x) => x.file === file && !x.sameAs)?.text ?? '';
  return packages;
}
