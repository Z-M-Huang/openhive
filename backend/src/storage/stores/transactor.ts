/**
 * Transactor implementation.
 *
 * @module storage/stores/transactor
 */

import type { Database } from '../database.js';
import type { Transactor, TransactionCallback } from '../../domain/interfaces.js';

export function newTransactor(db: Database): Transactor {
  return {
    async withTransaction<T>(fn: TransactionCallback<T>): Promise<T> {
      return db.enqueueWrite(() => {
        const conn = db.getConnection();
        let result: T;
        const tx = conn.transaction(() => {
          // better-sqlite3 transactions are synchronous. The callback must
          // return T synchronously (not a Promise). The TransactionCallback
          // type allows T | Promise<T> for interface flexibility, but at
          // the better-sqlite3 layer only sync execution is supported.
          const syncResult = fn(conn as unknown);
          if (syncResult instanceof Promise) {
            throw new Error(
              'Transaction callback must be synchronous when using better-sqlite3'
            );
          }
          result = syncResult as T;
        });
        tx();
        return result!;
      });
    },
  };
}
