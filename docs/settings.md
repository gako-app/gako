# Settings

Gako's settings are a JSON file. You can edit it on the settings screen (⌘, on macOS, Ctrl+,
elsewhere, or the gear at the right of the status bar) or in any editor; it's created the first time
something is changed:

| Platform | File |
|---|---|
| macOS | `~/Library/Application Support/Gako/settings.json` |
| Windows | `%APPDATA%\Gako\settings.json` |
| Linux | `~/.config/gako/settings.json` |

The settings screen and the About window show the path for your system.

The settings screen saves each change as it's made. It writes only what differs from the defaults:
setting a value back to its default, or **Reset**, takes it out of the file, so a later change of
default still reaches you. Keys it doesn't know are kept, in the file's order. The file is
rewritten with two-space indentation, replaced in one step, and written through a symbolic link if
it's one (a settings file kept with your dotfiles stays where it is). A setting the file sets has a
bar at its left on the screen.

Every key is optional; a key you leave out keeps its default.

Gako watches the file, so a change applies as soon as you save it:

- **At once:** the fonts, in the files, diffs and terminals already open; the agents offered for
  new terminals; the editor; `agentHooks`, for agents started from then on.
- **By opening the folder again**, which Gako does for you, keeping what's open: the repository
  settings (`scanDepth`, `scanIgnore`, `extraFolders`, `maxGitProcesses`, `debounceMs`,
  `untrackedLimit`, `gitTimeoutSecs`).
- **In terminals opened from then on:** `terminalScrollback`, `terminalRenderer` and
  `terminalMaxCombining`.
- **The next time Gako starts:** `base`.

If the file can't be read (it isn't valid JSON, or a value has the wrong type), Gako keeps the
last settings that worked and says so in the status bar, naming the file, the line and the column,
until the file is fixed. Opening a folder with the file in that state fails with the same message,
and the settings screen saves nothing until it's fixed.

These are your settings for every folder. A folder Gako opens can't change them: there are no
per-folder settings files.

## Example

```json
{
  "scanDepth": 3,
  "scanIgnore": ["node_modules", "vendor"],
  "agents": [
    { "name": "Claude Code", "command": ["claude"] },
    { "name": "Claude Code (Opus)", "command": ["claude", "--model", "opus"] },
    { "name": "Codex", "command": ["codex"] },
    { "name": "Aider", "command": ["aider"] }
  ],
  "editor": "zed",
  "terminalFontSize": 13
}
```

## Repositories

| Key | Default | What it does |
|---|---|---|
| `base` | none | The folder to open when none is given on the command line and none was open before. |
| `scanDepth` | `2` | How many folder levels below the base folder to look for repositories. |
| `scanIgnore` | `["node_modules"]` | Folder names never looked into. |
| `extraFolders` | `[]` | More folders to look for repositories in, to the same depth. |
| `maxGitProcesses` | `4` | How many `git` processes may run at once. |
| `debounceMs` | `150` | How long a repository must be quiet after a change before its status is refreshed, in milliseconds. |
| `untrackedLimit` | `2000` | Untracked files listed per repository; the rest are counted. |
| `gitTimeoutSecs` | `30` | Seconds before a `git` command is given up on. |

The defaults suit 10–30 repositories, one or two levels deep. For a larger layout, raise
`scanDepth` and `maxGitProcesses`; see [git.md](git.md).

## Agents and terminals

| Key | Default | What it does |
|---|---|---|
| `agents` | Claude Code, Codex, OpenCode, Pi | The programs offered when you start a terminal, besides your shell: a list of `{ "name": …, "command": [program, arguments…] }`. Each is offered only if its program is found. The list replaces the default one, so include the defaults you want to keep. |
| `agentHooks` | `true` | Start Claude Code with Gako's hook, so the agent bar can tell when it's waiting for approval. See [terminals.md](terminals.md#how-gako-knows). |
| `terminalScrollback` | `1000` | Rows kept per terminal. Each row costs memory at the terminal's full width. |
| `terminalRenderer` | `"webgl"` | `"webgl"`, or `"dom"` for slower drawing that uses less memory. |
| `terminalFontSize` | `12` on macOS, `14` elsewhere | In pixels. |
| `terminalFontFamily` | `"Menlo, Consolas, 'DejaVu Sans Mono', monospace"` | A CSS font list. |
| `terminalFontLigatures` | `false` | Draw the font's ligatures, such as `=>` and `!=` as one sign. See [terminals.md](terminals.md#ligatures). |
| `terminalMaxCombining` | `4` | Combining marks allowed on one character; a longer run is dropped whole. `0` turns the limit off. See [terminals.md](terminals.md#long-runs-of-combining-marks). |

## Files and diffs

The font of the file viewer and the diff view, set apart from the terminals'.

| Key | Default | What it does |
|---|---|---|
| `fileFontSize` | `12` | In pixels. |
| `fileFontFamily` | `"Menlo, Consolas, 'DejaVu Sans Mono', monospace"` | A CSS font list. |
| `fileFontLigatures` | `false` | Draw the font's ligatures, such as `=>` and `!=` as one sign. Only fonts made with them have any: Fira Code, JetBrains Mono, Cascadia Code. |

## Editor

| Key | Default | What it does |
|---|---|---|
| `editor` | the first known editor found | The editor "Open in editor" uses: a known editor's id, or a command line of your own. |

The known editors' ids are `vscode`, `vscode-insiders`, `vscodium`, `cursor`, `windsurf`, `zed` and
`sublime`. A command line is a list with `{file}`, `{line}` and `{column}` placeholders:

```json
{ "editor": ["nvim-qt", "+{line}", "{file}"] }
```

An editor picked from the Files view's context menu is remembered on that machine and wins over
this setting, until the editor is next set on the settings screen.
