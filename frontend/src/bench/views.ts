// Monaco views: a side-by-side diff and a file viewer. Read-only, always.
//
// The bench harness's views, with built-in timing.

import { frames, summarize } from '../metrics';
import { monaco } from '../monaco';
import type { Transport } from '../transport';

const common = {
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  theme: 'vs-dark',
  fontSize: 12,
} as const;

async function read(t: Transport, path: string): Promise<string> {
  return (await t.request<{ text: string }>('readFile', { path })).text;
}

export class DiffView {
  readonly el = document.createElement('div');
  private editor: monaco.editor.IStandaloneDiffEditor | null = null;

  constructor(parent: HTMLElement) {
    this.el.className = 'view';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  /** Opens the diff and returns the time from request to the first render of the computed diff. */
  async open(t: Transport, oldPath: string, newPath: string): Promise<number> {
    const t0 = performance.now();
    const [a, b] = await Promise.all([read(t, oldPath), read(t, newPath)]);
    this.editor ??= monaco.editor.createDiffEditor(this.el, {
      ...common,
      originalEditable: false,
      renderSideBySide: true,
    });
    const editor = this.editor;
    const previous = editor.getModel();
    // The diff is computed in a worker. Wait for an update that carries the new models' result:
    // getLineChanges() is null until then.
    const computed = new Promise<void>((resolve) => {
      const d = editor.onDidUpdateDiff(() => {
        if (editor.getLineChanges() === null) return;
        d.dispose();
        resolve();
      });
    });
    editor.setModel({
      original: monaco.editor.createModel(a, 'typescript'),
      modified: monaco.editor.createModel(b, 'typescript'),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
    await computed;
    await frames(2);
    return performance.now() - t0;
  }

  changes(): number {
    return this.editor?.getLineChanges()?.length ?? 0;
  }

  scroll(durationMs: number, pxPerSecond: number): Promise<ScrollResult> {
    return scrollTest(this.editor!.getModifiedEditor(), durationMs, pxPerSecond);
  }
}

export class FileView {
  readonly el = document.createElement('div');
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;

  constructor(parent: HTMLElement) {
    this.el.className = 'view';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  async open(t: Transport, path: string): Promise<number> {
    const t0 = performance.now();
    const text = await read(t, path);
    this.editor ??= monaco.editor.create(this.el, { ...common });
    const previous = this.editor.getModel();
    this.editor.setModel(monaco.editor.createModel(text, 'typescript'));
    previous?.dispose();
    await frames(2);
    return performance.now() - t0;
  }

  scroll(durationMs: number, pxPerSecond: number): Promise<ScrollResult> {
    return scrollTest(this.editor!, durationMs, pxPerSecond);
  }
}

export interface ScrollResult {
  fps: number;
  frames: number;
  durationMs: number;
  /** Frames that took longer than 50 ms: visible stalls. */
  stalls: number;
  maxFrameMs: number;
  p95FrameMs: number;
  scrolledPx: number;
}

/** Scrolls at a constant speed, one step per animation frame, and records frame times. */
async function scrollTest(
  editor: monaco.editor.ICodeEditor,
  durationMs: number,
  pxPerSecond: number,
): Promise<ScrollResult> {
  editor.setScrollTop(0);
  await frames(3);
  const max = editor.getScrollHeight() - editor.getLayoutInfo().height;
  const gaps: number[] = [];
  return new Promise((resolve) => {
    let start = 0;
    let last = 0;
    const step = (now: number) => {
      if (start === 0) {
        start = last = now;
      } else {
        gaps.push(now - last);
        last = now;
      }
      const elapsed = now - start;
      // Bounce at the ends so the whole run keeps scrolling.
      const travel = (elapsed / 1000) * pxPerSecond;
      const pos = travel % (2 * max);
      editor.setScrollTop(pos <= max ? pos : 2 * max - pos);
      if (elapsed < durationMs) {
        requestAnimationFrame(step);
        return;
      }
      const s = summarize(gaps);
      resolve({
        fps: (gaps.length / elapsed) * 1000,
        frames: gaps.length,
        durationMs: elapsed,
        stalls: gaps.filter((g) => g > 50).length,
        maxFrameMs: s.max,
        p95FrameMs: s.p95,
        scrolledPx: travel,
      });
    };
    requestAnimationFrame(step);
  });
}
