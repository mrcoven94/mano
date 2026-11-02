import type { ComputerAction } from "./actions";
import type { Computer } from "./computer";

/** One screen the recorder kept, with the actions that ran since the frame before it. */
export interface Frame {
  png: Uint8Array;
  actions: ComputerAction[];
}

/**
 * Wraps a computer so every screen a run shows is kept. A frame is kept
 * at each screenshot the run takes after something changed, and after
 * each typed value: a batch runs in pieces that end at a `type`, so a form
 * filled in one batch still shows each field filled, and the last such
 * frame is the whole form before it is sent on.
 */
export function recordFrames(inner: Computer): { computer: Computer; frames: () => Frame[] } {
  const frames: Frame[] = [];
  let since: ComputerAction[] = [];
  let changed = true;

  const screenshot = async (): Promise<Uint8Array> => {
    const png = await inner.screenshot();
    if (changed) {
      frames.push({ png, actions: since });
      since = [];
      changed = false;
    }
    return png;
  };

  const computer: Computer = {
    screenshot,
    async act(actions) {
      let piece: ComputerAction[] = [];
      for (const action of actions) {
        piece.push(action);
        if (action.type !== "type") continue;
        await inner.act(piece);
        since.push(...piece);
        changed = true;
        piece = [];
        await screenshot();
      }
      if (piece.length === 0) return;
      await inner.act(piece);
      since.push(...piece);
      changed = true;
    },
    async goto(url) {
      await inner.goto(url);
      changed = true;
    },
    stageFile: (name, data) => inner.stageFile(name, data),
    fileUploadHint: () => inner.fileUploadHint(),
    liveViewUrl: () => inner.liveViewUrl(),
    close: () => inner.close(),
  };
  return { computer, frames: () => [...frames] };
}
