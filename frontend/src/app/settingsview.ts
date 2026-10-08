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

// The settings screen: a form over the settings file. Each change is saved as it's made, through
// the core, which keeps the file's other keys and takes out values back at their default; the
// file's watcher then applies it, as it would an edit made in an editor. Edits made elsewhere show
// up here too, except in the field being typed in.

import type { Transport } from '../transport';
import { fill, h } from './dom';
import { icon, iconButton } from './icons';
import type { Settings } from './model';
import { type Applies, type Field, SECTIONS, joinCommand, splitCommand } from './settingsfields';

interface Info {
  path: string | null;
  settings: Settings;
  defaults: Settings;
  /** The keys the file sets. */
  inFile: string[];
  /** Why the file can't be read, if it can't. */
  error: string | null;
  knownEditors: { id: string; name: string }[];
}

type Agent = { name: string; command: string[] };

export interface SettingsHooks {
  pickFolder?: (defaultPath?: string) => Promise<string | null>;
  /** The editor was saved here: it replaces the one picked from the Files view. */
  editorSaved(): void;
}

const APPLIES: Record<Applies, string> = {
  reopen: 'Opens the folder again',
  'new terminals': 'New terminals',
  'next start': 'Next start',
};

interface Row {
  el: HTMLElement;
  error: HTMLElement;
  /** Shows a value that came from the file. */
  set(value: unknown): void;
}

/** What's wrong with a number typed in, if anything (the core would say so in its own terms). */
function numberProblem(value: number, min: number | undefined, step: number): string | null {
  if (!Number.isFinite(value)) return 'Not a number.';
  if (step === 1 && !Number.isInteger(value)) return 'A whole number.';
  if (min !== undefined && value < min) return `At least ${min}.`;
  return null;
}

export class SettingsView {
  readonly el = h('section', { class: 'settings' });
  private header = h('header', { class: 'diff-header' });
  private banner = h('div', { class: 'settings-banner', hidden: true });
  private form = h('fieldset', { class: 'settings-form' });
  private info: Info | null = null;
  private rows = new Map<keyof Settings, Row>();
  /** Installed editors' ids, and whether each agent's program was found, in order. */
  private installedEditors = new Set<string>();
  private agentsFound: boolean[] = [];
  private ticket = 0;

  constructor(private t: Transport, private hooks: SettingsHooks) {
    this.el.append(this.header, h('div', { class: 'settings-scroll' }, this.banner, this.form));
  }

  /** Brings the screen up to date when its tab is shown: drawn the first time, its values refreshed
   * after that (keeping where it was scrolled to). */
  async show(): Promise<void> {
    if (this.rows.size) return this.refresh(true);
    await this.load();
    this.render();
  }

  /** The settings changed, here or in the file: shows them, leaving alone the field being edited. */
  async refresh(evenHidden = false): Promise<void> {
    if ((!evenHidden && !this.el.isConnected) || !this.info) return;
    await this.load();
    this.renderHeader();
    for (const [key, row] of this.rows) {
      if (!row.el.contains(document.activeElement)) {
        row.set(this.info.settings[key]);
        row.error.hidden = true;
      }
      row.el.classList.toggle('modified', this.info.inFile.includes(key));
    }
  }

  private async load(): Promise<void> {
    const ticket = ++this.ticket;
    const [info, editors, agents] = await Promise.all([
      this.t.request<Info>('settingsGet'),
      this.t.request<{ editors: { id: string }[] }>('editors').catch(() => ({ editors: [] })),
      this.t.request<{ agents: { path: string | null }[] }>('agents').catch(() => ({ agents: [] })),
    ]);
    if (ticket !== this.ticket) return;
    this.info = info;
    this.installedEditors = new Set(editors.editors.map((e) => e.id));
    this.agentsFound = agents.agents.map((a) => a.path !== null);
  }

  private renderHeader(): void {
    const info = this.info!;
    fill(this.header, h('div', { class: 'diff-title settings-title' }, h('span', { class: 'diff-name' }, 'Settings'),
      info.path ? h('span', { class: 'dim settings-path', 'data-tip': info.path }, `  ${info.path}`) : null));
    this.banner.hidden = !info.error;
    if (info.error) {
      fill(this.banner, icon('warning'), h('div', {},
        h('div', {}, "The settings file can't be read, so nothing can be saved here until it's fixed in an editor. Gako keeps using the last settings that worked."),
        h('div', { class: 'settings-banner-detail' }, info.error)));
    }
    this.form.disabled = !!info.error;
  }

  private render(): void {
    this.renderHeader();
    this.rows.clear();
    fill(this.form, SECTIONS.map((s) => h('div', { class: 'settings-section' },
      h('h2', {}, s.title),
      s.fields.map((f) => this.row(f)))));
  }

  private row(f: Field): HTMLElement {
    const info = this.info!;
    const error = h('div', { class: 'setting-error', hidden: true });
    const save = (value: unknown) => {
      const problem = f.type === 'number' && typeof value === 'number' ? numberProblem(value, f.min, f.step ?? 1) : null;
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
      } else this.save(f.key, value, error);
    };
    const control = this.control(f, save);
    const reset = h('button', { class: 'link setting-reset', onclick: () => save(null) }, 'Reset');
    const el = h('div', { class: `setting ${info.inFile.includes(f.key) ? 'modified' : ''}`, 'data-key': f.key },
      h('div', { class: 'setting-head' },
        h('span', { class: 'setting-title' }, f.title),
        h('code', { class: 'setting-key' }, f.key),
        f.applies ? h('span', { class: 'setting-applies', 'data-tip': 'When a change takes effect' }, APPLIES[f.applies]) : null,
        h('span', { class: 'spacer' }),
        reset),
      h('div', { class: 'setting-help' }, f.help),
      control.el,
      error);
    control.set(info.settings[f.key]);
    this.rows.set(f.key, { el, error, set: control.set });
    return el;
  }

  private async save(key: keyof Settings, value: unknown, error: HTMLElement): Promise<void> {
    try {
      await this.t.request('settingsSave', { changes: { [key]: value } });
      error.hidden = true;
      if (key === 'editor') this.hooks.editorSaved();
      await this.refresh();
    } catch (e) {
      error.textContent = String((e as Error).message ?? e);
      error.hidden = false;
    }
  }

  /** The control for a field: its element, and how to show a value in it. */
  private control(f: Field, save: (value: unknown) => void): { el: HTMLElement; set(value: unknown): void } {
    switch (f.type) {
      case 'number': {
        const input = h('input', { type: 'number', class: 'setting-input short', min: f.min, step: f.step ?? 1 });
        input.addEventListener('change', () => save(input.value.trim() === '' ? null : Number(input.value)));
        return { el: input, set: (v) => { input.value = String(v); } };
      }
      case 'bool': {
        const input = h('input', { type: 'checkbox' });
        input.addEventListener('change', () => save(input.checked));
        return { el: h('label', { class: 'setting-check' }, input, 'On'), set: (v) => { input.checked = !!v; } };
      }
      case 'text': {
        const input = h('input', { type: 'text', class: 'setting-input', spellcheck: false, placeholder: String(this.info!.defaults[f.key]) });
        input.addEventListener('change', () => save(input.value.trim() === '' ? null : input.value));
        return { el: input, set: (v) => { input.value = String(v ?? ''); } };
      }
      case 'choice': {
        const select = h('select', { class: 'setting-input short' }, f.options.map(([v, label]) => h('option', { value: v }, label)));
        select.addEventListener('change', () => save(select.value));
        return { el: select, set: (v) => { select.value = String(v); } };
      }
      case 'lines': {
        const area = h('textarea', { class: 'setting-input', rows: 3, spellcheck: false });
        area.addEventListener('change', () => save(area.value.split('\n').map((l) => l.trim()).filter(Boolean)));
        return { el: area, set: (v) => { area.value = ((v as string[] | null) ?? []).join('\n'); } };
      }
      case 'folder': {
        const input = h('input', { type: 'text', class: 'setting-input', spellcheck: false, placeholder: 'None' });
        input.addEventListener('change', () => save(input.value.trim() || null));
        const browse = this.hooks.pickFolder
          ? h('button', { type: 'button', onclick: async () => {
            const path = await this.hooks.pickFolder?.(input.value.trim() || undefined).catch(() => null);
            if (path) {
              input.value = path;
              save(path);
            }
          } }, 'Choose…')
          : null;
        return { el: h('div', { class: 'setting-line' }, input, browse), set: (v) => { input.value = String(v ?? ''); } };
      }
      case 'agents':
        return this.agentsControl(save);
      case 'editor':
        return this.editorControl(save);
    }
  }

  /** The agents: a name and a command line each, in the order they're offered. A list with an
   * incomplete row isn't saved until it's complete. */
  private agentsControl(save: (value: unknown) => void): { el: HTMLElement; set(value: unknown): void } {
    let rows: { name: string; line: string }[] = [];
    const list = h('div', { class: 'agents-list' });
    const note = h('div', { class: 'setting-help', hidden: true }, 'Give each agent a name and a command to save the list.');
    const commit = () => {
      const complete = rows.every((r) => r.name.trim() && splitCommand(r.line).length);
      note.hidden = complete;
      if (complete) save(rows.map((r): Agent => ({ name: r.name.trim(), command: splitCommand(r.line) })));
    };
    const move = (i: number, to: number) => {
      rows.splice(to, 0, ...rows.splice(i, 1));
      draw();
      commit();
    };
    const draw = () => {
      fill(list, rows.map((r, i) => {
        const name = h('input', { type: 'text', class: 'setting-input agent-name', value: r.name, placeholder: 'Name', spellcheck: false });
        const line = h('input', { type: 'text', class: 'setting-input', value: r.line, placeholder: 'Command and arguments', spellcheck: false });
        name.addEventListener('input', () => { r.name = name.value; });
        line.addEventListener('input', () => { r.line = line.value; });
        name.addEventListener('change', commit);
        line.addEventListener('change', commit);
        const found = this.agentsFound[i];
        return h('div', { class: 'agent-row' },
          name, line,
          h('span', { class: `agent-found ${found ? 'yes' : 'no'}`, 'data-tip': found ? 'Installed' : 'Not found: it isn\'t offered' }, found ? 'Found' : 'Not found'),
          iconButton('prev', 'Move up', () => move(i, i - 1), { disabled: i === 0 }),
          iconButton('next', 'Move down', () => move(i, i + 1), { disabled: i === rows.length - 1 }),
          iconButton('remove', 'Remove', () => {
            rows.splice(i, 1);
            draw();
            commit();
          }));
      }));
    };
    const add = h('button', { type: 'button', onclick: () => {
      rows.push({ name: '', line: '' });
      draw();
      (list.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
      note.hidden = false;
    } }, 'Add agent');
    return {
      el: h('div', {}, list, h('div', { class: 'setting-line' }, add), note),
      set: (v) => {
        rows = ((v as Agent[] | null) ?? []).map((a) => ({ name: a.name, line: joinCommand(a.command) }));
        note.hidden = true;
        draw();
      },
    };
  }

  /** The editor: the first one found, one Gako knows, or a command line of your own. */
  private editorControl(save: (value: unknown) => void): { el: HTMLElement; set(value: unknown): void } {
    const known = this.info!.knownEditors;
    const select = h('select', { class: 'setting-input short' },
      h('option', { value: '' }, 'The first one found'),
      known.map((e) => h('option', { value: e.id }, this.installedEditors.has(e.id) ? e.name : `${e.name} (not found)`)),
      h('option', { value: '*' }, 'A command of your own'));
    const line = h('input', { type: 'text', class: 'setting-input', spellcheck: false, placeholder: 'nvim-qt +{line} {file}' });
    const custom = h('div', { class: 'setting-line', hidden: true }, line);
    const help = h('div', { class: 'setting-help', hidden: true }, '{file}, {line} and {column} stand for where to open.');
    select.addEventListener('change', () => {
      custom.hidden = help.hidden = select.value !== '*';
      if (select.value === '*') line.focus();
      else save(select.value || null);
    });
    line.addEventListener('change', () => {
      const parts = splitCommand(line.value);
      if (parts.length) save(parts);
    });
    return {
      el: h('div', {}, h('div', { class: 'setting-line' }, select), custom, help),
      set: (v) => {
        const cmd = Array.isArray(v);
        select.value = cmd ? '*' : typeof v === 'string' ? v : '';
        if (typeof v === 'string' && select.value !== v) {
          // An id Gako doesn't know (the core says so when it's used): shown as it is.
          select.append(h('option', { value: v }, `${v} (unknown)`));
          select.value = v;
        }
        line.value = cmd ? joinCommand(v as string[]) : '';
        custom.hidden = help.hidden = !cmd;
      },
    };
  }
}
