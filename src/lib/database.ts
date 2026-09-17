import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { migrate, SCHEMA_VERSION } from "./migrations";

export const DATA_DIR = path.resolve(process.env.APP_DATA_DIR ?? path.join(process.cwd(), "data"));
export const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
export const RECORDING_DIR = path.join(DATA_DIR, "recordings");

type Connection = { db: DatabaseSync; version: number };
const globalDb = globalThis as typeof globalThis & { __interviewDatabases?: Map<string, Connection> };

/** Lazy, path-keyed connections survive Next dev reloads without touching data at build time. */
export function getDb(): DatabaseSync {
  const connections = globalDb.__interviewDatabases ??= new Map();
  let connection = connections.get(DATA_DIR);
  if (!connection) {
    for (const dir of [DATA_DIR, SNAPSHOT_DIR, RECORDING_DIR]) fs.mkdirSync(dir, { recursive: true });
    connection = { db: new DatabaseSync(path.join(DATA_DIR, "app.db")), version: 0 };
    connections.set(DATA_DIR, connection);
  }
  if (connection.version !== SCHEMA_VERSION) {
    migrate(connection.db);
    connection.version = SCHEMA_VERSION;
  }
  return connection.db;
}

export function closeDb(): void {
  globalDb.__interviewDatabases?.get(DATA_DIR)?.db.close();
  globalDb.__interviewDatabases?.delete(DATA_DIR);
}
