// The seam between the text line and Mano accounts. When the worker
// sees a handle with no person, the directory resolves it (creating the
// person in the engine, once the engine lands) and the worker routes to
// that person from then on. The stand-in maps deterministically so every
// isolate routes the same handle to the same person without storage.
import { hashId } from "./handles.js";

export interface PersonResolution {
  personId: string;
}

export interface AccountsDirectory {
  resolvePerson(normalizedHandle: string): Promise<PersonResolution>;
}

export class StandInAccountsDirectory implements AccountsDirectory {
  private pepper: string;

  constructor(pepper: string) {
    this.pepper = pepper;
  }

  async resolvePerson(normalizedHandle: string): Promise<PersonResolution> {
    const hash = await hashId(normalizedHandle, this.pepper, "mano-person:v1");
    return { personId: `person_${hash.slice(0, 24)}` };
  }
}

export function buildAccountsDirectory(env: { MANO_HANDLE_PEPPER: string }): AccountsDirectory {
  // The engine-backed directory lands with the engine accounts routes;
  // until then every handle maps deterministically, same input same person.
  return new StandInAccountsDirectory(env.MANO_HANDLE_PEPPER);
}

// A sign-in code is exactly six digits. Callers pass digits only; the
// text below is the one copy Channels ever sends, so no caller can put
// other words on the line through this seam.
export function isSignInCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

export function signInCodeMessage(code: string): string {
  return `Your Mano code is ${code}. It expires in 10 minutes.`;
}
