export interface MemoryOwnerStat {
  owner: string;
  scope: "session" | "app-session" | "stream" | "global";
  itemCount: number;
  estimatedBytes: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SessionMemoryCensus {
  estimatedBytes: number;
  owners: MemoryOwnerStat[];
}

export interface MemoryStatsProvider {
  getMemoryStats(): MemoryOwnerStat[];
}
