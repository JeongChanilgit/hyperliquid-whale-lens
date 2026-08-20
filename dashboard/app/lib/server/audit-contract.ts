export type AuditWalletInput = {
  address: string;
  label: string;
  enabled?: boolean;
  sortOrder?: number;
};

export type AuditRunInput = {
  id: string;
  mode: string;
  state: string;
  startedAt: number;
  stoppedAt?: number | null;
  executionEnabled: boolean;
  testnet: boolean;
};

export type AuditOrderInput = {
  id: string;
  sourceEventId: string;
  runId: string;
  whaleAddress: string;
  symbol: string;
  side: "long" | "short";
  segment?: string | null;
  status: string;
  size: number;
  price?: number | null;
  createdAt: number;
};

export type AuditLogInput = {
  id: string;
  eventKey: string;
  runId: string;
  kind: string;
  severity: "info" | "warning" | "error";
  message: string;
  whaleAddress?: string | null;
  symbol?: string | null;
  latencyMs?: number | null;
  detail?: Record<string, unknown> | null;
  occurredAt: number;
};

export type AuditPerformanceInput = {
  runId: string;
  whaleAddress: string;
  roi30d?: number | null;
  realizedPnl: number;
  fees: number;
  executedNotionalUsd: number;
  executions: number;
  blockedExecutions: number;
  errors: number;
  updatedAt: number;
};

export type AuditSyncInput = {
  wallets?: AuditWalletInput[];
  run?: AuditRunInput | null;
  orders?: AuditOrderInput[];
  logs?: AuditLogInput[];
  performance?: AuditPerformanceInput[];
};

export type AuditWallet = AuditWalletInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
};

export type AuditRun = AuditRunInput & {
  createdAt: number;
  updatedAt: number;
};

export type AuditOrder = AuditOrderInput;
export type AuditLog = AuditLogInput;
export type AuditPerformance = AuditPerformanceInput;

export type AuditPage = {
  nextCursor: string | null;
};

export type AuditReadResponse = {
  wallets: AuditWallet[];
  run: AuditRun | null;
  performance: AuditPerformance[];
  orders: AuditOrder[];
  logs: AuditLog[];
  pages: {
    orders: AuditPage;
    logs: AuditPage;
  };
};
