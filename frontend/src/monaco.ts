// Monaco, set up once for the whole frontend: the editor API, its one worker (diff computation),
// and syntax highlighting for every language Monaco has a tokenizer for, each loaded on first use.
// No language services: a read-only viewer doesn't need them.

import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/register.all.js';
// The icon font (diff gutter markers, folded-region icons); editor.api.js alone doesn't load it.
import 'monaco-editor/features/codicon/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// JSON only ships as a full language service; its JavaScript tokenizer is enough to read it.
const aliases: Record<string, string> = { json: 'javascript', jsonc: 'javascript', json5: 'javascript' };

/** The Monaco language for a file path, by extension or file name; plain text otherwise. */
export function languageFor(path: string): string {
  const name = path.split('/').pop()!.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  if (aliases[ext.slice(1)]) return aliases[ext.slice(1)];
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
    if (ext && lang.extensions?.includes(ext)) return lang.id;
  }
  return 'plaintext';
}

export { monaco };
