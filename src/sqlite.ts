import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type Value = string | number | null;
interface Statement {
  get(...values: Value[]): unknown;
  all(...values: Value[]): unknown[];
  run(...values: Value[]): { changes: number | bigint };
  finalize?(): void;
}
interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
}

export class Sqlite {
  private closed = false;

  private constructor(private readonly database: Database) {}

  static async open(filename: string): Promise<Sqlite> {
    await mkdir(dirname(filename), { recursive: true });
    let database: Database;
    if ("Bun" in globalThis) {
      const moduleName = "bun:sqlite";
      const { Database } = await import(moduleName) as {
        Database: new (filename: string, options: { create: boolean }) => Database;
      };
      database = new Database(filename, { create: true });
    } else {
      const { DatabaseSync } = await import("node:sqlite");
      database = new DatabaseSync(filename);
    }
    const connection = new Sqlite(database);
    try {
      database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  get<T>(sql: string, ...values: Value[]): T | undefined {
    const statement = this.database.prepare(sql);
    try {
      const row = statement.get(...values);
      return row == null ? undefined : { ...row as object } as T;
    } finally { statement.finalize?.(); }
  }

  all<T>(sql: string, ...values: Value[]): T[] {
    const statement = this.database.prepare(sql);
    try {
      return statement.all(...values).map((row) => ({ ...row as object }) as T);
    } finally { statement.finalize?.(); }
  }

  run(sql: string, ...values: Value[]): number {
    const statement = this.database.prepare(sql);
    try {
      return Number(statement.run(...values).changes);
    } finally {
      // Bun otherwise retains SQLite file handles until statement GC, even after database.close().
      statement.finalize?.();
    }
  }

  transaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
