import { PhoneCodeService } from "../src/codes";
import { RecordingChannels } from "../src/channels";
import { StandInEngineAccounts } from "../src/engine";
import { AccountsService } from "../src/service";
import { PersonStore } from "../src/store";
import { StandInWorkOS } from "../src/workos";

export const TEST_PEPPER = "test-pepper-do-not-use-live";
export const TEST_KEK_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function testSetup(now?: () => number) {
  const store = new PersonStore({ pepper: TEST_PEPPER, kekB64: TEST_KEK_B64, now });
  const codes = new PhoneCodeService({ pepper: TEST_PEPPER, now });
  const workos = new StandInWorkOS();
  const engine = new StandInEngineAccounts(now);
  const channels = new RecordingChannels();
  const service = new AccountsService({ store, codes, workos, engine, channels, pepper: TEST_PEPPER, now });
  return { store, codes, workos, engine, channels, service };
}

// Synthetic handles only. Never real numbers or emails.
export const PHONE_A = "+15550100111";
export const PHONE_B = "+15550100222";
export const EMAIL_A = "synthetic-alba-001@example.com";
export const EMAIL_B = "synthetic-bex-002@example.com";
