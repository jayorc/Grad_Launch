import type { SearchSession } from "@gradlaunch/shared";
import { isMemoryMode } from "../lib/data-mode";
import { SearchSessionModel } from "../models/search-session-model";
import { db } from "./in-memory-db";

export class SearchSessionRepository {
  async create(session: SearchSession): Promise<SearchSession> {
    if (isMemoryMode()) {
      db.searchSessions.push(session);
      return session;
    }

    await SearchSessionModel.create(session);
    return session;
  }

  async listByStudent(studentId: string): Promise<SearchSession[]> {
    if (isMemoryMode()) {
      return db.searchSessions
        .filter((session) => session.studentId === studentId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    }

    const sessions = await SearchSessionModel.find({ studentId }).sort({ createdAt: -1 }).lean();
    return sessions.map((session) => ({
      id: String(session.id),
      studentId: String(session.studentId),
      durationMinutes: Number(session.durationMinutes),
      strictness: String(session.strictness) as SearchSession["strictness"],
      startedAt: String(session.startedAt),
      completedAt: String(session.completedAt),
      resultJobIds: Array.isArray(session.resultJobIds) ? session.resultJobIds.map(String) : [],
      summary: String(session.summary)
    }));
  }
}
