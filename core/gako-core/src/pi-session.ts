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

// Gako's extension for Pi, loaded for one run with `pi -e` (see agents.rs, which writes it out):
// whenever Pi switches session (/new, /resume, /fork, /clone), it tells the terminal which one it's
// on, so Gako reopens that one. Pi itself takes `--session-id`, which finds sessions in the folder
// it runs in only, so a session of another folder isn't reported. Pi loads this file as it is,
// without type checking, so it has no types of its own.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export default function (pi) {
  pi.on("session_start", (event, ctx) => {
    // At startup Pi is on the session Gako started it on.
    if (event.reason === "startup" || event.reason === "reload" || !process.stdout.isTTY) return;
    const session = ctx.sessionManager;
    const id = session.getSessionId();
    if (!session.getSessionFile() || !/^[\w-]{1,100}$/.test(id)) return;
    if (real(session.getCwd()) !== real(process.cwd())) return;
    process.stdout.write(`\x1b]6973;session=${id}\x07`);
  });
}
