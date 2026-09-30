/**
 * Suspended-agents repository — executes the statements in
 * sql/suspended-agents.sql against the `suspended_agents` table; no SQL
 * text lives here. The public store (storage/suspended-agents.ts) owns
 * (de)serialisation and error handling.
 */

import { getDatabase, inTransaction } from "../db.js";
import { suspendedAgentsSql } from "../sql/statements.generated.js";

export interface SuspendedAgentRow {
  readonly id: string;
  readonly depth: number;
  readonly suspended_at: number;
  readonly spec: string;
}

/** Write every row in one transaction. */
export function upsertAll(rows: readonly SuspendedAgentRow[]): void {
  inTransaction(() => {
    const stmt = getDatabase().prepare(suspendedAgentsSql.upsert);
    for (const row of rows) {
      stmt.run(row.id, row.depth, row.suspended_at, row.spec);
    }
  });
}

/** Read and delete every row atomically — parents (lower depth) first. */
export function takeAll(): SuspendedAgentRow[] {
  return inTransaction(() => {
    const database = getDatabase();
    const rows = database
      .prepare(suspendedAgentsSql.listAll)
      .all() as SuspendedAgentRow[];
    database.prepare(suspendedAgentsSql.removeAll).run();
    return rows;
  });
}
