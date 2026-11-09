import type { ComputerAction } from "./actions";
import type { Computer } from "./computer";

/** One screen the recorder kept, with the actions that ran since the frame before it. */
export interface Frame {
  png: Uint8Array;
  actions: ComputerAction[];
}

/**
 * True for an action that changes what a field holds: a typed value, or a
 * key such as Backspace or Delete. Enter and Tab move on, and select-all
 * only selects.
 */
export function editsForm(action: ComputerAction): boolean {
  if (action.type === "type") return true;
  if (action.type !== "keypress") return false;
  const keys = action.keys.map((k) => k.toLowerCase());
  const movesOn = keys.some((k) => k === "enter" || k === "return" || k === "tab");
  const selectsAll = keys.includes("a") && keys.some((k) => ["ctrl", "control", "cmd", "meta"].includes(k));
  return !movesOn && !selectsAll;
}

/**
 * Wraps a computer so every screen a run shows is kept. A frame is kept
 * at each screenshot the run takes after something changed, and after
 * each edit: a batch runs in pieces that end at an edit, so a form filled
 * in one batch still shows each field filled, and the last such frame is
 * the whole form before it is sent on. Recording never stops a run: when
 * a screenshot taken only to record fails, the recording ends, the run
 * goes on, and frames() is empty.
 */
export function recordFrames(inner: Computer): { computer: Computer; frames: () => Frame[] } {
  const frames: Frame[] = [];
  let since: ComputerAction[] = [];
  let changed = true;
  let broken = false;

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
        if (!editsForm(action)) continue;
        await inner.act(piece);
        since.push(...piece);
        changed = true;
        piece = [];
        if (broken) continue;
        try {
          await screenshot();
        } catch {
          broken = true;
        }
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
    close: () => inner.close(),
  };
  return { computer, frames: () => (broken ? [] : [...frames]) };
}
