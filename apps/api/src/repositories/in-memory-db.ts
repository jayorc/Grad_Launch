import type {
  Application,
  ApplicationRun,
  Job,
  ResumeRecord,
  SearchSession,
  StudentAccount,
  StudentProfile,
  UserSession
} from "@gradlaunch/shared";
import {
  seedAccounts,
  seedApplicationRuns,
  seedApplications,
  seedJobs,
  seedSearchSessions,
  seedStudents
} from "../data/seed";
import { hashPassword } from "../lib/auth";

export interface AuditEvent {
  id: string;
  type: string;
  message: string;
  createdAt: string;
}

class InMemoryDatabase {
  students: StudentProfile[] = [];
  accounts: Array<StudentAccount & { passwordHash?: string }> = [];
  sessions: UserSession[] = [];
  jobs: Job[] = [];
  searchSessions: SearchSession[] = [];
  applications: Application[] = [];
  applicationRuns: ApplicationRun[] = [];
  resumes: ResumeRecord[] = [];
  auditEvents: AuditEvent[] = [];
}

export const db = new InMemoryDatabase();

export async function resetMemoryDatabase(seedDemoData: boolean) {
  db.students = seedDemoData ? structuredClone(seedStudents) : [];
  db.jobs = seedDemoData ? structuredClone(seedJobs) : [];
  db.searchSessions = seedDemoData ? structuredClone(seedSearchSessions) : [];
  db.applications = seedDemoData ? structuredClone(seedApplications) : [];
  db.applicationRuns = seedDemoData ? structuredClone(seedApplicationRuns) : [];
  db.sessions = [];
  db.resumes = [];
  db.auditEvents = [];
  db.accounts = seedDemoData
    ? await Promise.all(
        seedAccounts.map(async (account) => ({
          ...structuredClone(account),
          passwordHash: await hashPassword(account.password)
        }))
      )
    : [];
}
