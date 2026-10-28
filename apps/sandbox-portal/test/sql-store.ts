import { DatabaseSync } from "node:sqlite";
import { PortalStoreSql, type SqlStorage } from "../src/store";

/** PortalStoreSql backed by real SQLite, so the DO queries run in tests. */
export function makeSqlStore(): PortalStoreSql {
  const db = new DatabaseSync(":memory:");
  const sql: SqlStorage = {
    exec: (query: string, ...params: unknown[]) => {
      if (params.length === 0 && query.split(";").filter((part) => part.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [] as unknown[], rowsWritten: 0 };
      }
      const stmt = db.prepare(query);
      const args = params as Array<string | number | bigint | Buffer | null>;
      if (/^\s*SELECT/i.test(query)) {
        return { toArray: () => stmt.all(...args) as unknown[], rowsWritten: 0 };
      }
      const info = stmt.run(...args);
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  return new PortalStoreSql(sql);
}
