import { MentraSession } from "../session";
import { _CompatMentraSessionAdapter } from "../session/internal/_CompatMentraSessionAdapter";

export interface _MiniAppSessionRecord {
  session: MentraSession;
  compatSession: _CompatMentraSessionAdapter;
  userId: string;
  sessionId: string;
}

export class _MiniAppSessionRegistry {
  private readonly bySessionId = new Map<string, _MiniAppSessionRecord>();
  private readonly byUserId = new Map<string, _MiniAppSessionRecord>();

  set(record: _MiniAppSessionRecord): void {
    this.bySessionId.set(record.sessionId, record);
    this.byUserId.set(record.userId, record);
  }

  getBySessionId(sessionId: string): _MiniAppSessionRecord | null {
    return this.bySessionId.get(sessionId) ?? null;
  }

  getByUserId(userId: string): _MiniAppSessionRecord | null {
    return this.byUserId.get(userId) ?? null;
  }

  deleteBySessionId(sessionId: string): _MiniAppSessionRecord | null {
    const record = this.bySessionId.get(sessionId) ?? null;
    if (!record) {
      return null;
    }

    this.bySessionId.delete(sessionId);
    if (this.byUserId.get(record.userId)?.sessionId === sessionId) {
      this.byUserId.delete(record.userId);
    }

    return record;
  }

  deleteIfSameSession(sessionId: string, session: MentraSession): _MiniAppSessionRecord | null {
    const record = this.bySessionId.get(sessionId) ?? null;
    if (!record || record.session !== session) {
      return null;
    }

    return this.deleteBySessionId(sessionId);
  }

  deleteByUserId(userId: string): _MiniAppSessionRecord | null {
    const record = this.byUserId.get(userId) ?? null;
    if (!record) {
      return null;
    }

    this.byUserId.delete(userId);
    if (this.bySessionId.get(record.sessionId)?.userId === userId) {
      this.bySessionId.delete(record.sessionId);
    }

    return record;
  }

  values(): _MiniAppSessionRecord[] {
    return Array.from(this.bySessionId.values());
  }

  clear(): void {
    this.bySessionId.clear();
    this.byUserId.clear();
  }

  get size(): number {
    return this.bySessionId.size;
  }
}
