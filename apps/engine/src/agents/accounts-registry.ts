// Accounts registry: the routing index for who a person is.
//
// One singleton Durable Object (opened by ACCOUNTS_REGISTRY_NAME) maps
// each claimed handle hash and each WorkOS user to exactly one person.
// Claims are atomic because check and insert run with no await between
// them inside this one object. The registry is only an index: the
// PersonAgent stays the system of record for identities, thread,
// counts and activity. Only the worker and person agents call here;
// service authentication happens in the worker before any call.
import type { Env } from "../env.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const WORKOS_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

export class AccountsRegistry implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    void _env;
    this.ctx = ctx;
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS persons(person_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, created_via TEXT NOT NULL)`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS handle_claims(handle_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, claimed_at TEXT NOT NULL)`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS workos_links(workos_user_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, linked_at TEXT NOT NULL)`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_handle_claims_person ON handle_claims(person_id)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_workos_links_person ON workos_links(person_id)`);
    });
  }

  private db(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private newPersonId(): string {
    return `person_${crypto.randomUUID().replace(/-/g, "")}`;
  }

  // Inserts a fresh person row, retrying once on the near-impossible
  // ID collision.
  private insertPerson(via: string): string {
    for (let attempt = 0; attempt < 3; attempt++) {
      const personId = this.newPersonId();
      try {
        this.db().exec("INSERT INTO persons VALUES (?, ?, ?)", personId, new Date().toISOString(), via);
        return personId;
      } catch {
        // Collision: regenerate.
      }
    }
    throw new Error("Could not mint a person ID.");
  }

  async lookupHandle(handleHash: string): Promise<{ personId: string } | null> {
    if (!HASH_PATTERN.test(handleHash)) throw new Error("Handle hash is invalid.");
    const rows = this.db().exec("SELECT person_id FROM handle_claims WHERE handle_hash = ?", handleHash).toArray() as unknown as {
      person_id: string;
    }[];
    return rows[0] ? { personId: rows[0].person_id } : null;
  }

  // Returns the person for a handle hash, creating one when new. The
  // select and the inserts below run with no await between them, so
  // two racing claims for one handle yield one person.
  async claimHandle(handleHash: string, via: string): Promise<{ personId: string; created: boolean }> {
    if (!HASH_PATTERN.test(handleHash)) throw new Error("Handle hash is invalid.");
    if (typeof via !== "string" || !via || via.length > 32) throw new Error("Claim source is invalid.");
    const existing = this.db().exec(
      "SELECT person_id FROM handle_claims WHERE handle_hash = ?",
      handleHash,
    ).toArray() as unknown as { person_id: string }[];
    if (existing[0]) return { personId: existing[0].person_id, created: false };
    const personId = this.insertPerson(via);
    this.db().exec("INSERT INTO handle_claims VALUES (?, ?, ?)", handleHash, personId, new Date().toISOString());
    return { personId, created: true };
  }

  async lookupWorkos(workosUserId: string): Promise<{ personId: string } | null> {
    if (!WORKOS_ID_PATTERN.test(workosUserId)) throw new Error("WorkOS user ID is invalid.");
    const rows = this.db().exec("SELECT person_id FROM workos_links WHERE workos_user_id = ?", workosUserId).toArray() as unknown as {
      person_id: string;
    }[];
    return rows[0] ? { personId: rows[0].person_id } : null;
  }

  // Links a WorkOS user, preferring the person who already claimed the
  // given handle hash (text first, then web sign-in finds the same
  // person). Atomic like claimHandle: one WorkOS user, one person.
  async claimWorkos(
    workosUserId: string,
    handleHash: string | null,
  ): Promise<{ personId: string; created: boolean }> {
    if (!WORKOS_ID_PATTERN.test(workosUserId)) throw new Error("WorkOS user ID is invalid.");
    if (handleHash !== null && !HASH_PATTERN.test(handleHash)) throw new Error("Handle hash is invalid.");
    const linked = this.db().exec(
      "SELECT person_id FROM workos_links WHERE workos_user_id = ?",
      workosUserId,
    ).toArray() as unknown as { person_id: string }[];
    if (linked[0]) return { personId: linked[0].person_id, created: false };
    if (handleHash) {
      const byHandle = this.db().exec(
        "SELECT person_id FROM handle_claims WHERE handle_hash = ?",
        handleHash,
      ).toArray() as unknown as { person_id: string }[];
      if (byHandle[0]) {
        this.db().exec(
          "INSERT OR IGNORE INTO workos_links VALUES (?, ?, ?)",
          workosUserId,
          byHandle[0].person_id,
          new Date().toISOString(),
        );
        return { personId: byHandle[0].person_id, created: false };
      }
    }
    const personId = this.insertPerson("workos");
    this.db().exec("INSERT INTO workos_links VALUES (?, ?, ?)", workosUserId, personId, new Date().toISOString());
    if (handleHash) {
      this.db().exec(
        "INSERT OR IGNORE INTO handle_claims VALUES (?, ?, ?)",
        handleHash,
        personId,
        new Date().toISOString(),
      );
    }
    return { personId, created: true };
  }

  async hasPerson(personId: string): Promise<boolean> {
    if (typeof personId !== "string" || !personId || personId.length > 200) return false;
    const rows = this.db().exec("SELECT person_id FROM persons WHERE person_id = ?", personId).toArray();
    return rows.length > 0;
  }

  // Moves every handle and WorkOS link from one person to another on
  // merge. Idempotent: repointing twice moves nothing the second time.
  async repointPerson(fromPersonId: string, intoPersonId: string): Promise<{ handles: number; workos: number }> {
    const handles = this.db().exec("UPDATE handle_claims SET person_id = ? WHERE person_id = ?", intoPersonId, fromPersonId);
    const workos = this.db().exec("UPDATE workos_links SET person_id = ? WHERE person_id = ?", intoPersonId, fromPersonId);
    return { handles: Number(handles.rowsWritten), workos: Number(workos.rowsWritten) };
  }

  // Forgets a person and every link to them on delete. Idempotent.
  async removePerson(personId: string): Promise<void> {
    this.db().exec("DELETE FROM handle_claims WHERE person_id = ?", personId);
    this.db().exec("DELETE FROM workos_links WHERE person_id = ?", personId);
    this.db().exec("DELETE FROM persons WHERE person_id = ?", personId);
  }
}
