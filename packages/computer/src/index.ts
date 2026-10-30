/**
 * The computer Mano drives: a desktop with a browser, worked through
 * screenshots, mouse and keyboard. The model sees screenshots and returns
 * computer-use actions; runLoop executes them and hands back the next
 * screenshot. Nothing here keeps state server-side: every model call sends
 * store:false and replays the trajectory.
 *
 * The desktop fills forms; it never files them. A pending safety check
 * stops the run and comes back to the caller as status "safety_check"
 * (the loop never acknowledges one), and a login prompt ends the run as
 * infeasible: there is no live view, and the agent never sees passwords.
 * Filing goes through Engine's action gateway after the person's yes.
 *
 * Backends: PlaywrightComputer drives real Chromium on this machine (the
 * local stand-in; needs `npx playwright install chromium` once). Every
 * request to an origin other than the allowed one is aborted before it is
 * sent, in every page and popup. ModalComputer drives a hosted desktop
 * through the session service in modal/ (see its docstring for the
 * service's secret and network rules). It sends the person's Engine id and
 * the service token to open a session, and the per-session secret the
 * service returns on every control call.
 *
 * Run it: set COMPUTER_BACKEND (playwright by default). For modal, set
 * MODAL_COMPUTER_URL, MODAL_COMPUTER_TOKEN and COMPUTER_PERSON_ID (see
 * .env.example), then call runLoop with a ModelClient. Test it:
 * pnpm --filter @mano/computer check (tsc plus vitest against fake screens;
 * the real-Chromium tests run when Playwright's Chromium is installed).
 */
import type { Computer, ComputerOptions } from "./computer";
import { ModalComputer } from "./modal";
import { PlaywrightComputer } from "./playwright";

export { isComputerCall, outputText, type ComputerAction, type ComputerCall, type SafetyCheck } from "./actions";
export type { Computer, ComputerOptions } from "./computer";
export { LOOP_INSTRUCTIONS, runLoop, type LoopOptions, type LoopOutcome } from "./loop";
export { FakeModelClient, FetchModelClient, type ModelClient, type ResponsePayload, type ResponseRequest } from "./model";
export { ModalComputer, type ModalComputerOptions } from "./modal";
export { PlaywrightComputer, type BrowserLauncher, type LaunchedPage, type PageLike, type PlaywrightComputerOptions } from "./playwright";

/** Open the backend named by COMPUTER_BACKEND (playwright by default). */
export function computerFromEnv(env: Record<string, string | undefined>, options: ComputerOptions = {}): Computer {
  if ((env["COMPUTER_BACKEND"] ?? "playwright") === "modal") {
    const baseUrl = env["MODAL_COMPUTER_URL"];
    const personId = env["COMPUTER_PERSON_ID"];
    if (!baseUrl) throw new Error("COMPUTER_BACKEND=modal needs MODAL_COMPUTER_URL");
    if (!personId) throw new Error("COMPUTER_BACKEND=modal needs COMPUTER_PERSON_ID");
    const token = env["MODAL_COMPUTER_TOKEN"];
    return new ModalComputer({ baseUrl, personId, ...(token ? { token } : {}), ...options });
  }
  const profileDir = env["COMPUTER_PROFILE_DIR"];
  return new PlaywrightComputer({ ...(profileDir ? { profileDir } : {}), ...options });
}
