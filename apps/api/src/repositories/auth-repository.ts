import type { StudentAccount, UserSession } from "@gradlaunch/shared";
import { isMemoryMode } from "../lib/data-mode";
import { AccountModel } from "../models/account-model";
import { SessionModel } from "../models/session-model";
import { db } from "./in-memory-db";

export class AuthRepository {
  async getAccountByEmail(email: string): Promise<StudentAccount | undefined> {
    if (isMemoryMode()) {
      const account = db.accounts.find((item) => item.email === email.toLowerCase());
      return account ? { ...account } : undefined;
    }

    const account = await AccountModel.findOne({ email: email.toLowerCase() }).lean();
    return account ? mapAccount(account as Record<string, unknown>) : undefined;
  }

  async createAccount(account: StudentAccount & { passwordHash?: string }): Promise<StudentAccount & { passwordHash?: string }> {
    if (isMemoryMode()) {
      const storedAccount = {
        ...account,
        email: account.email.toLowerCase()
      };

      db.accounts.push(storedAccount);
      return storedAccount;
    }

    await AccountModel.create({
      id: account.id,
      studentId: account.studentId,
      email: account.email.toLowerCase(),
      passwordHash: account.passwordHash
    });

    return account;
  }

  async createSession(session: UserSession): Promise<UserSession> {
    if (isMemoryMode()) {
      db.sessions = db.sessions.filter((item) => item.studentId !== session.studentId);
      db.sessions.push(session);
      return session;
    }

    await SessionModel.deleteMany({ studentId: session.studentId });
    await SessionModel.create({
      ...session,
      expiresAt: new Date(session.expiresAt)
    });

    return session;
  }

  async getSessionByToken(token: string): Promise<UserSession | undefined> {
    if (isMemoryMode()) {
      return db.sessions.find((session) => session.token === token);
    }

    const session = await SessionModel.findOne({ token }).lean();
    return session ? mapSession(session as Record<string, unknown>) : undefined;
  }

  async getSessionById(id: string): Promise<UserSession | undefined> {
    if (isMemoryMode()) {
      return db.sessions.find((session) => session.id === id);
    }

    const session = await SessionModel.findOne({ id }).lean();
    return session ? mapSession(session as Record<string, unknown>) : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    if (isMemoryMode()) {
      db.sessions = db.sessions.filter((session) => session.token !== token);
      return;
    }

    await SessionModel.deleteOne({ token });
  }
}

function mapAccount(account: Record<string, unknown>): StudentAccount & { passwordHash?: string } {
  return {
    id: String(account.id),
    studentId: String(account.studentId),
    email: String(account.email),
    password: "",
    passwordHash: typeof account.passwordHash === "string" ? account.passwordHash : undefined,
    createdAt: typeof account.createdAt === "string"
      ? account.createdAt
      : new Date(account.createdAt as Date | string | number).toISOString()
  };
}

function mapSession(session: Record<string, unknown>): UserSession {
  return {
    id: String(session.id),
    studentId: String(session.studentId),
    email: String(session.email),
    token: String(session.token),
    createdAt: typeof session.createdAt === "string"
      ? session.createdAt
      : new Date(session.createdAt as Date | string | number).toISOString(),
    expiresAt: typeof session.expiresAt === "string"
      ? session.expiresAt
      : new Date(session.expiresAt as Date | string | number).toISOString()
  };
}
