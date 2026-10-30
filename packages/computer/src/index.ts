/**
 * The computer Mano drives: a desktop with a browser, worked through
 * screenshots, mouse and keyboard. The model sees screenshots and returns
 * computer-use actions; this package executes them and hands back the next
 * screenshot. Nothing here keeps state server-side: every model call sends
 * store:false and replays the trajectory.
 *
 * Backends: PlaywrightComputer drives real Chromium on this machine (the
 * local stand-in; needs `npx playwright install chromium` once).
 * ModalComputer drives a hosted desktop through the session service in
 * modal/ (deploy it from that directory with `modal deploy app.py`, with
 * the modal client and fastapi in the local Python). Each person gets a
 * browser profile: a directory for Playwright, a Modal volume for Modal.
 *
 * The Executor files a renewal on the sandbox portal through the computer
 * and reconciles through GET /submissions/:key. Logins and two-factor
 * codes go to the person through the live view; the agent never sees
 * passwords. Safety checks fail closed unless the caller approves them.
 *
 * Run it: set META_MODEL_API_KEY, MODEL_BASE_URL and PORTAL_URL (see
 * .env.example), pick COMPUTER_BACKEND, and call execute() with the
 * household and the files. Test it: pnpm --filter @mano/computer check
 * (tsc plus vitest against fake screens; no browser or key needed).
 */
import type { Computer, ComputerOptions } from "./computer";
import { ModalComputer } from "./modal";
import { PlaywrightComputer } from "./playwright";

export { isComputerCall, outputText, type ComputerAction, type ComputerCall, type SafetyCheck } from "./actions";
export type { Computer, ComputerOptions } from "./computer";
export { Executor, type CaseRecord, type ExecuteFile, type ExecuteOutcome, type ExecuteRequest, type ExecuteResult, type ExecutorOptions, type HouseholdFields, type SubmissionStatus } from "./executor";
export { LOOP_INSTRUCTIONS, runLoop, type LoopOptions, type LoopOutcome } from "./loop";
export { FakeModelClient, FetchModelClient, type ModelClient, type ResponsePayload, type ResponseRequest } from "./model";
export { ModalComputer, type ModalComputerOptions } from "./modal";
export { PlaywrightComputer, type BrowserLauncher, type LaunchedPage, type PageLike, type PlaywrightComputerOptions } from "./playwright";

/** Open the backend named by COMPUTER_BACKEND (playwright by default). */
export function computerFromEnv(env: Record<string, string | undefined>, options: ComputerOptions = {}): Computer {
  if ((env["COMPUTER_BACKEND"] ?? "playwright") === "modal") {
    const baseUrl = env["MODAL_COMPUTER_URL"];
    const profile = env["COMPUTER_PROFILE"] ?? "default";
    if (!baseUrl) throw new Error("COMPUTER_BACKEND=modal needs MODAL_COMPUTER_URL");
    const token = env["MODAL_COMPUTER_TOKEN"];
    return new ModalComputer({ baseUrl, profile, ...(token ? { token } : {}), ...options });
  }
  const profileDir = env["COMPUTER_PROFILE_DIR"];
  return new PlaywrightComputer({ ...(profileDir ? { profileDir } : {}), ...options });
}
