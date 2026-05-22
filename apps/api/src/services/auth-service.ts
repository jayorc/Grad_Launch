import type { AuthResponse, LoginInput, RegisterInput, StudentProfile, UpdateProfileInput, UserSession } from "@gradlaunch/shared";
import { hashPassword, signSessionToken, verifyPassword } from "../lib/auth";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";
import { AuthRepository } from "../repositories/auth-repository";
import { StudentRepository } from "../repositories/student-repository";
import { ResumeService } from "./resume-service";

export class AuthService {
  constructor(
    private readonly auth = new AuthRepository(),
    private readonly students = new StudentRepository(),
    private readonly resumes = new ResumeService()
  ) {}

  async login(input: LoginInput): Promise<AuthResponse> {
    const account = await this.auth.getAccountByEmail(input.email);

    if (!account?.passwordHash || !(await verifyPassword(input.password, account.passwordHash))) {
      throw new Error("Invalid email or password.");
    }

    const student = await this.students.getById(account.studentId);

    if (!student) {
      throw new Error("Student profile not found.");
    }

    return {
      session: await this.createSession(student),
      student
    };
  }

  async register(input: RegisterInput): Promise<AuthResponse> {
    if (await this.auth.getAccountByEmail(input.email) || await this.students.getByEmail(input.email)) {
      throw new Error("An account with this email already exists.");
    }

    const student: StudentProfile = {
      id: createId("student"),
      fullName: input.fullName,
      email: input.email,
      degree: input.degree,
      graduationYear: input.graduationYear,
      targetRoles: input.targetRoles,
      preferredLocations: input.preferredLocations,
      workModes: ["remote", "hybrid"],
      skills: input.skills,
      expectedSalaryLpa: undefined,
      visaRequired: false,
      automationMode: "full_autopilot",
      defaultStrictness: "balanced",
      bio: "",
      completeProfile: {
        workAuthorizationCountries: [],
        preferredEmploymentTypes: [],
        certifications: [],
        languages: [],
        achievements: [],
        educationHistory: [],
        employmentHistory: [],
        projectHistory: [],
        screeningAnswers: [],
        customFacts: [],
        eeo: {}
      },
      resumeId: input.resumeId
    };

    if (input.completeProfile) {
      student.completeProfile = {
        ...student.completeProfile,
        ...input.completeProfile,
        workAuthorizationCountries: input.completeProfile.workAuthorizationCountries ?? [],
        preferredEmploymentTypes: input.completeProfile.preferredEmploymentTypes ?? [],
        certifications: input.completeProfile.certifications ?? [],
        languages: input.completeProfile.languages ?? [],
        achievements: input.completeProfile.achievements ?? [],
        educationHistory: input.completeProfile.educationHistory ?? [],
        employmentHistory: input.completeProfile.employmentHistory ?? [],
        projectHistory: input.completeProfile.projectHistory ?? [],
        screeningAnswers: input.completeProfile.screeningAnswers ?? [],
        customFacts: input.completeProfile.customFacts ?? [],
        eeo: input.completeProfile.eeo ?? {}
      };
    }

    await this.students.create(student);
    if (input.resumeId) {
      await this.resumes.assignExistingResumeToStudent(input.resumeId, student.id).catch(() => undefined);
    }
    await this.auth.createAccount({
      id: createId("account"),
      studentId: student.id,
      email: student.email,
      password: "",
      passwordHash: await hashPassword(input.password),
      createdAt: nowIso()
    });

    return {
      session: await this.createSession(student),
      student
    };
  }

  async getSessionFromToken(token: string): Promise<AuthResponse> {
    const session = await this.auth.getSessionByToken(token);

    if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
      throw new Error("Session not found.");
    }

    const student = await this.students.getById(session.studentId);

    if (!student) {
      throw new Error("Student profile not found.");
    }

    return { session, student };
  }

  async logout(token: string): Promise<void> {
    await this.auth.deleteSession(token);
  }

  async updateProfile(studentId: string, input: UpdateProfileInput): Promise<StudentProfile> {
    return this.students.update(studentId, input);
  }

  private async createSession(student: StudentProfile): Promise<UserSession> {
    const sessionId = createId("session");
    const token = signSessionToken({
      sessionId,
      studentId: student.id,
      email: student.email
    });

    const session: UserSession = {
      id: sessionId,
      studentId: student.id,
      email: student.email,
      token,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
    };

    return this.auth.createSession(session);
  }
}
