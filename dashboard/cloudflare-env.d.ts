/**
 * The Worker runtime supplies these interfaces at deployment. Keep this
 * declaration intentionally narrow so local TypeScript checks can type the
 * D1-backed audit store without adding a second Worker-runtime dependency.
 */
interface D1Meta {
  [key: string]: unknown;
}

interface D1Result<T = unknown> {
  success: boolean;
  results: T[];
  meta: D1Meta;
}

interface D1Response {
  success: boolean;
  meta: D1Meta;
  error?: string;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
  };
}
