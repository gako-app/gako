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

import './style.css';

import { App, config, type Hello } from './app';
import { boot } from '../boot';
import { Metrics, ms } from '../metrics';
import { openDiff, scenarios } from './scenarios';
import { connect } from '../transport';

async function main(): Promise<void> {
  const b = boot();
  const t = await connect(b);
  const hello = await t.request<Hello>('hello');
  const cfg = config(hello, b.shell);
  const metrics = new Metrics(t, { runId: cfg.runId, shell: cfg.shell, scenario: cfg.scenario });
  const app = new App(t, metrics, cfg);
  if (import.meta.env.DEV) Object.assign(window, { gako: app });
  metrics.log('connected', { sinceNavMs: performance.now(), hello, cfg: { ...cfg, hello: undefined }, ua: navigator.userAgent });
  metrics.show('shell', `${cfg.shell} · ${cfg.renderer} · ${cfg.cols}x${cfg.rows} · scrollback ${cfg.scrollback}`);

  const run = scenarios[cfg.scenario];
  if (run) {
    // Cold start ends when the window is usable: tabs drawn and the core answering.
    requestAnimationFrame(() => metrics.log('ready', { sinceNavMs: performance.now() }));
    await run(app);
    return;
  }

  // Manual mode: a shell and the diff, plus buttons for each scenario's measurements.
  const shell = await app.openTerminal('Shell');
  app.select(shell);
  requestAnimationFrame(() => metrics.log('ready', { sinceNavMs: performance.now() }));
  app.action('+ terminal', async () => app.select(await app.openTerminal(`Shell ${app.terminals.size + 1}`)));
  app.action('open diff', async () => {
    app.select('Diff');
    const m = JSON.parse((await t.request<{ text: string }>('readFile', { path: app.fixture('manifest.json') })).text);
    metrics.show('diff open', ms(await openDiff(app, m)));
  });
  app.action('echo x20', async () => {
    const term = [...app.terminals.values()].find((x) => x.visible);
    if (!term) return;
    const v: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await term.measureEcho();
      if (r !== null) v.push(r);
    }
    v.sort((a, b) => a - b);
    metrics.show('echo', `median ${ms(v[v.length >> 1] ?? NaN)}`);
  });
}

main().catch((e) => {
  document.body.textContent = String(e?.stack ?? e);
});
