/**
 * The structural read plane, typed.
 *
 * Recorded SQLite structure only: tables, views, columns, declared keys,
 * and foreign keys. A row window carries no assertion id and no invented
 * identity — `navigable` is true only when the backend verified a declared
 * key over the observed rows. This file imports only `read`, so its
 * read-only boundary is visible in its import list.
 */

import { read } from "./plane";

export type SQLiteColumn = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  /** SQLite generated-column kind, where the adapter recorded one. */
  generated?: "VIRTUAL" | "STORED" | null;
};

export type SQLiteForeignKeyRef = {
  id: number;
  seq: number;
  table: string;
  from: string;
  /** The recorded parent column, or null when the declaration omitted it. */
  to: string | null;
  /** Parent PK column resolved for display when `to` was omitted. */
  resolved_to?: string | null;
};

export type SQLiteTable = {
  name: string;
  columns: SQLiteColumn[];
  /** Declared primary-key columns in key order. Empty when undeclared. */
  pk: string[];
  /** Foreign keys grouped by constraint, each group ordered by seq. */
  fks: SQLiteForeignKeyRef[][];
  rows: number;
};

export type SQLiteSchema = {
  file: string;
  file_sha256: string;
  tables: SQLiteTable[];
  views: string[];
};

export type SQLiteRows = {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  offset: number;
  /** True only when a declared key was verified over the observed rows. */
  navigable: boolean;
  ordering_guarantee?: string;
};

export const sqliteApi = {
  schema: () => read<SQLiteSchema>("/sqlite/schema"),
  rows: (table: string, options: { limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams({
      table,
      limit: String(options.limit ?? 50),
      offset: String(options.offset ?? 0),
    });
    return read<SQLiteRows>(`/sqlite/rows?${query}`);
  },
};
