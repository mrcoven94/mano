// Engine's SQL store is written against the Workers SqlStorage type. The
// agent's tests run it on node:sqlite through the same exec shape, so
// this names just that shape for the type checker.
declare interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}
