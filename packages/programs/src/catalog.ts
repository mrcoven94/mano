import { AZ } from "./data/az.js";
import { CA } from "./data/ca.js";
import { FL } from "./data/fl.js";
import { IL } from "./data/il.js";
import { NY } from "./data/ny.js";
import { OH } from "./data/oh.js";
import { TX } from "./data/tx.js";
import { WA } from "./data/wa.js";
import type { StateCatalog, StateCode } from "./types.js";

// The day every source in this version was read. A new version means facts
// were checked again or changed.
export const CATALOG_VERSION = "2026-10-30";

export const CATALOG: Record<StateCode, StateCatalog> = { CA, TX, NY, FL, IL, WA, AZ, OH };
