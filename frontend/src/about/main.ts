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

// The About window: what Gako is, its version and where it keeps its files; its licence; and the
// third-party software it includes. The shell opens it (the Gako menu on macOS, the status bar's
// button everywhere) at #about, #licence or #notices, hands it facts through its preload script
// (window.__GAKO_ABOUT__), and serves the two texts at legal/.

import './style.css';
import appIcon from '../../../shells/electron/build/icon.svg';
import { h } from '../app/dom';
import { icon, type IconName } from '../app/icons';
import { type LicenceBlock, type NoticePackage, parseLicence, parseNotices } from './legal';

declare const __GAKO_BUILD__: { describe: string; date: string };

interface AboutInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  os: string;
  arch: string;
  /** The home folder, shown as ~ in the paths below (not on Windows). */
  home: string;
  settingsFile: string;
  settingsExists: boolean;
  dataFolder: string;
}

declare global {
  interface Window {
    __GAKO_ABOUT__?: {
      info: AboutInfo;
      reveal(what: 'settings' | 'data'): Promise<void>;
      openNotice(which: 'electron' | 'chromium'): Promise<void>;
    };
  }
}

const WEBSITE = 'https://gako.app';
const SOURCE = 'https://github.com/gako-app/gako';
const ISSUES = `${SOURCE}/issues`;

const shell = window.__GAKO_ABOUT__;
const info = shell?.info;
const build = __GAKO_BUILD__;

type Tab = 'about' | 'licence' | 'notices';
const TABS: [Tab, string][] = [['about', 'About'], ['licence', 'Licence'], ['notices', 'Third-party notices']];

const external = (href: string, ...children: (Node | string)[]) =>
  h('a', { href, target: '_blank', rel: 'noreferrer' }, ...children);
const tabLink = (tab: Tab, text: string) => h('a', { href: `#${tab}` }, text);

/** Text with the licences' <https://…> links made clickable. */
function rich(text: string): (Node | string)[] {
  return text.split(/<(https?:\/\/[^>\s]+)>/).map((part, i) => (i % 2 ? external(part, part) : part));
}

function tilde(path: string): string {
  if (!info || info.os.startsWith('Windows') || !path.startsWith(`${info.home}/`)) return path;
  return `~${path.slice(info.home.length)}`;
}

// ---- About

function details(): [string, string][] {
  return [
    ['Version', info?.version ?? 'unknown'],
    ['Build', build.date ? `${build.describe}, ${build.date}` : build.describe],
    ['Electron', info?.electron ?? '–'],
    ['Chromium', info?.chrome ?? '–'],
    ['Node.js', info?.node ?? '–'],
    ['System', info ? `${info.os} (${info.arch})` : navigator.userAgent],
  ];
}

function copyButton(text: () => string): HTMLButtonElement {
  const b: HTMLButtonElement = h('button', { class: 'quiet' }, icon('copy'), 'Copy');
  b.onclick = async () => {
    await navigator.clipboard.writeText(text());
    b.replaceChildren(icon('done'), 'Copied');
    setTimeout(() => b.replaceChildren(icon('copy'), 'Copy'), 1500);
  };
  return b;
}

function fileRow(label: string, path: string, note: string, what: 'settings' | 'data', exists: boolean) {
  return [
    h('dt', {}, label),
    h('dd', {},
      h('div', { class: 'path-row' },
        h('code', { class: 'path', title: path }, tilde(path)),
        exists && shell ? h('button', { class: 'quiet', onclick: () => shell.reveal(what) }, icon('folder-open'), 'Show') : null),
      h('div', { class: 'note' }, note)),
  ];
}

function aboutPanel(): HTMLElement {
  const link = (name: IconName, text: string, href: string) => external(href, icon(name), text);
  return h('div', { class: 'about' },
    h('div', { class: 'hero' },
      h('img', { class: 'app-icon', src: appIcon, alt: '' }),
      h('div', {},
        h('h1', {}, 'Gako'),
        h('div', { class: 'version' }, `Version ${info?.version ?? 'unknown'}`),
        h('p', { class: 'tagline' }, 'Review and supervise coding agents across many Git repositories at once.'),
        h('div', { class: 'links' },
          link('website', 'gako.app', WEBSITE),
          link('source', 'Source code', SOURCE),
          link('issue', 'Report an issue', ISSUES)))),
    h('section', {},
      h('div', { class: 'section-head' },
        h('h2', {}, 'Details'),
        copyButton(() => details().map(([k, v]) => `${k}: ${v}`).join('\n'))),
      h('dl', { class: 'facts' }, details().map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    info ? h('section', {},
      h('h2', {}, 'Files'),
      h('dl', { class: 'facts' },
        fileRow('Settings', info.settingsFile,
          info.settingsExists ? 'Your settings, for every folder Gako opens.' : 'Not created yet: Gako runs on its defaults.',
          'settings', info.settingsExists),
        fileRow('App data', info.dataFolder, 'Window state, open tabs and caches. Delete it to start Gako afresh.', 'data', true))) : null,
    h('footer', { class: 'legal' },
      h('p', {}, 'Copyright © 2026 João Sena Ribeiro'),
      h('p', {},
        'Gako is free software under the ', tabLink('licence', 'GNU Affero General Public License'),
        ', version 3 or later, and comes with no warranty. It includes ', tabLink('notices', 'third-party software'), '.')));
}

// ---- Licence

function licenceBlock(b: LicenceBlock, anchors: Map<string, HTMLElement>, after?: LicenceBlock): HTMLElement {
  switch (b.kind) {
    case 'title':
      return h('header', { class: 'lic-title' }, h('h1', {}, b.lines[0]), b.lines.slice(1).map((l) => h('div', {}, l)));
    case 'lines':
      // Under the title, the FSF's copyright; anywhere else, a sample to copy, kept monospaced.
      return h(after?.kind === 'title' ? 'p' : 'pre', { class: after?.kind === 'title' ? 'lic-copyright' : 'lic-lines' },
        ...b.lines.flatMap((l, i) => [i ? h('br') : '', ...rich(l)]));
    case 'heading': {
      const el = h('h2', { class: 'lic-heading' }, b.text);
      anchors.set(b.text, el);
      return el;
    }
    case 'section': {
      const el = h('h3', { class: 'lic-section' }, h('span', { class: 'num' }, `${b.number}.`), b.title);
      anchors.set(`${b.number}. ${b.title}`, el);
      return el;
    }
    case 'item':
      return h('p', { class: 'lic-item' }, h('span', { class: 'num' }, `${b.label})`), h('span', {}, ...rich(b.text)));
    case 'para':
      return h('p', {}, ...rich(b.text));
  }
}

async function licencePanel(): Promise<HTMLElement> {
  const text = await fetchText('legal/licence.txt');
  const anchors = new Map<string, HTMLElement>();
  const doc = h('article', { class: 'doc' },
    h('div', { class: 'summary' },
      h('h2', {}, 'In short'),
      h('p', {},
        'You may use Gako for any purpose, study and change its source code, and share copies of it, changed or not. ',
        'If you share Gako, or let people use a changed version of it over a network, you must offer them its source ',
        'code under this same licence. Gako comes with no warranty.'),
      h('p', { class: 'note' },
        'This summary isn\'t part of the licence; the text below is what applies. Gako\'s source code is at ',
        external(SOURCE, SOURCE.replace('https://', '')), '.')),
    parseLicence(text).map((b, i, all) => licenceBlock(b, anchors, all[i - 1])));
  const toc = h('nav', { class: 'toc' }, [...anchors].map(([label, el]) =>
    h('a', { href: '#licence', onclick: (e: Event) => { e.preventDefault(); el.scrollIntoView({ block: 'start' }); } },
      label.replace(/^(END OF )?TERMS AND CONDITIONS$/, (t) => t.charAt(0) + t.slice(1).toLowerCase()))));
  return h('div', { class: 'licence' }, toc, doc);
}

// ---- Third-party notices

function packageRow(p: NoticePackage): HTMLDetailsElement {
  const texts = h('div', { class: 'pkg-texts' });
  const row: HTMLDetailsElement = h('details', { class: 'pkg' },
    h('summary', {},
      icon('expand'),
      h('span', { class: 'pkg-name' }, p.name),
      h('span', { class: 'pkg-version' }, p.version),
      h('span', { class: 'spacer' }),
      h('span', { class: 'chip' }, p.licence),
      p.source && /^https?:\/\//.test(p.source)
        ? h('a', { class: 'icon-link', href: p.source, target: '_blank', rel: 'noreferrer', title: p.source, onclick: (e: Event) => e.stopPropagation() }, icon('external'))
        : h('span', { class: 'icon-link' })),
    texts);
  row.addEventListener('toggle', () => {
    if (!row.open || texts.childElementCount) return;
    if (!p.texts.length) texts.append(h('p', { class: 'note' }, `The package ships no licence file; its licence is ${p.licence}.`));
    for (const t of p.texts) {
      texts.append(
        h('div', { class: 'pkg-file' }, t.file, t.sameAs ? h('span', { class: 'note' }, ` · the same text as ${t.sameAs}'s`) : null),
        h('pre', {}, t.text));
    }
  });
  return row;
}

async function noticesPanel(): Promise<HTMLElement> {
  const pkgs = parseNotices(await fetchText('legal/notices.txt'));
  const groups = [...new Set(pkgs.map((p) => p.group))];
  const count = (g: string) => pkgs.filter((p) => p.group === g).length;
  const npm = count('npm packages');
  const crates = count('Rust crates');
  const rows = pkgs.map((p) => ({ p, el: packageRow(p) }));
  const sections = groups.map((g) => {
    const items = rows.filter((r) => r.p.group === g);
    const count = h('span', { class: 'count' }, String(items.length));
    return { count, items, el: h('section', {}, h('h2', {}, g, count), items.map((r) => r.el)) };
  });
  const none = h('p', { class: 'note empty', hidden: true }, 'No package matches.');
  const filter: HTMLInputElement = h('input', { type: 'search', placeholder: 'Filter by name or licence', spellcheck: false });
  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const s of sections) {
      let n = 0;
      for (const r of s.items) {
        const hit = !q || `${r.p.name} ${r.p.licence}`.toLowerCase().includes(q);
        r.el.hidden = !hit;
        if (hit) n++;
      }
      s.el.hidden = !n;
      s.count.textContent = q ? `${n} of ${s.items.length}` : String(s.items.length);
      shown += n;
    }
    none.hidden = shown > 0;
  };
  const chromiumButton = (which: 'electron' | 'chromium', text: string) =>
    shell ? h('button', { class: 'quiet', onclick: () => shell.openNotice(which) }, icon('external'), text) : null;
  return h('div', { class: 'notices' },
    h('div', { class: 'notices-head' },
      h('p', {},
        `Gako includes ${npm} npm packages, in its window, and ${crates} Rust crates, in its core. `,
        'Each is listed with its licence; open one to read the licence\'s text.'),
      h('p', {}, 'Electron and Chromium, which run Gako\'s window, come with notices of their own.'),
      shell ? h('div', { class: 'buttons' }, chromiumButton('electron', 'Electron\'s licence'), chromiumButton('chromium', 'Chromium\'s notices')) : null,
      h('label', { class: 'filter' }, icon('search'), filter)),
    h('div', { class: 'pkg-list' }, sections.map((s) => s.el), none));
}

// ---- The window

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

const panels = new Map<Tab, HTMLElement>();
const tabButtons = new Map<Tab, HTMLElement>();
const main = h('main', {});

function makePanel(tab: Tab): HTMLElement {
  const el = h('div', { class: `panel panel-${tab}`, role: 'tabpanel' });
  if (tab === 'about') el.append(aboutPanel());
  else {
    el.append(h('p', { class: 'note loading' }, 'Loading…'));
    (tab === 'licence' ? licencePanel() : noticesPanel())
      .then((content) => el.replaceChildren(content))
      .catch((e) => el.replaceChildren(h('p', { class: 'note loading' }, `Couldn't load this: ${(e as Error).message}`)));
  }
  main.append(el);
  return el;
}

function show(): void {
  const hash = location.hash.slice(1);
  const tab: Tab = TABS.some(([t]) => t === hash) ? (hash as Tab) : 'about';
  if (!panels.has(tab)) panels.set(tab, makePanel(tab));
  for (const [t, el] of panels) el.hidden = t !== tab;
  for (const [t, el] of tabButtons) el.setAttribute('aria-selected', String(t === tab));
  document.title = tab === 'about' ? 'About Gako' : `${TABS.find(([t]) => t === tab)![1]} – Gako`;
}

const nav = h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([tab, label]) => {
  const b = h('a', { href: `#${tab}`, role: 'tab' }, label);
  tabButtons.set(tab, b);
  return b;
}));
document.documentElement.classList.toggle('mac', navigator.platform.startsWith('Mac'));
document.getElementById('app')!.append(nav, main);
window.addEventListener('hashchange', show);
// Escape (unless it's clearing the filter), or ⌘W / Ctrl+W, closes the window.
window.addEventListener('keydown', (e) => {
  const clearing = e.key === 'Escape' && e.target instanceof HTMLInputElement && e.target.value;
  if ((e.key === 'Escape' && !clearing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w')) {
    e.preventDefault();
    window.close();
  }
});
show();
