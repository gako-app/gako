# Settings

Gako has no settings screen. Its settings are a JSON file, which you create when you want to
change something:

| Platform | File |
|---|---|
| macOS | `~/Library/Application Support/Gako/settings.json` |
| Windows | `%APPDATA%\Gako\settings.json` |
| Linux | `~/.config/gako/settings.json` |

The About window shows the path for your system, with a button to show the file once it exists.

Every key is optional; a key you leave out keeps its default. Gako reads the file each time it
opens a folder, lists agents, or finds editors, so changes apply the next time you do one of those.
If the file isn't valid JSON, Gako says so and names it.

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

The font of the file viewer and the diff view, set apart from the terminals'. Changes apply the
next time you open a folder.

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
this setting.
