import type { StudentProfile, UpdateProfileInput } from "@gradlaunch/shared";
import { isMemoryMode } from "../lib/data-mode";
import { StudentModel } from "../models/student-model";
import { db } from "./in-memory-db";

export class StudentRepository {
  async getById(studentId: string): Promise<StudentProfile | undefined> {
    if (isMemoryMode()) {
      return db.students.find((student) => student.id === studentId);
    }

    const student = await StudentModel.findOne({ id: studentId }).lean();
    return student ? mapStudent(student as Record<string, unknown>) : undefined;
  }

  async getByEmail(email: string): Promise<StudentProfile | undefined> {
    if (isMemoryMode()) {
      return db.students.find((student) => student.email === email.toLowerCase());
    }

    const student = await StudentModel.findOne({ email: email.toLowerCase() }).lean();
    return student ? mapStudent(student as Record<string, unknown>) : undefined;
  }

  async list(): Promise<StudentProfile[]> {
    if (isMemoryMode()) {
      return [...db.students].sort((left, right) => right.id.localeCompare(left.id));
    }

    const students = await StudentModel.find().sort({ createdAt: -1 }).lean();
    return students.map((student) => mapStudent(student as Record<string, unknown>));
  }

  async create(student: StudentProfile): Promise<StudentProfile> {
    if (isMemoryMode()) {
      const storedStudent = {
        ...student,
        email: student.email.toLowerCase()
      };

      db.students.push(storedStudent);
      return storedStudent;
    }

    await StudentModel.create({
      ...student,
      email: student.email.toLowerCase()
    });

    return student;
  }

  async update(studentId: string, input: UpdateProfileInput): Promise<StudentProfile> {
    if (isMemoryMode()) {
      const index = db.students.findIndex((student) => student.id === studentId);

      if (index === -1) {
        throw new Error("Student not found.");
      }

      db.students[index] = {
        ...db.students[index],
        ...input
      };

      return db.students[index];
    }

    const student = await StudentModel.findOneAndUpdate(
      { id: studentId },
      { $set: input },
      { new: true }
    ).lean();

    if (!student) {
      throw new Error("Student not found.");
    }

    return mapStudent(student as Record<string, unknown>);
  }

  async setResumeId(studentId: string, resumeId: string): Promise<void> {
    if (isMemoryMode()) {
      const student = db.students.find((item) => item.id === studentId);

      if (student) {
        student.resumeId = resumeId;
      }

      return;
    }

    await StudentModel.updateOne({ id: studentId }, { $set: { resumeId } });
  }
}

function mapStudent(student: Record<string, unknown>): StudentProfile {
  return {
    id: String(student.id),
    fullName: String(student.fullName),
    email: String(student.email),
    degree: String(student.degree),
    graduationYear: Number(student.graduationYear),
    targetRoles: Array.isArray(student.targetRoles) ? student.targetRoles.map(String) : [],
    preferredLocations: Array.isArray(student.preferredLocations) ? student.preferredLocations.map(String) : [],
    workModes: Array.isArray(student.workModes) ? student.workModes.map(String) as StudentProfile["workModes"] : ["remote"],
    skills: Array.isArray(student.skills) ? student.skills.map(String) : [],
    expectedSalaryLpa: typeof student.expectedSalaryLpa === "number" ? student.expectedSalaryLpa : undefined,
    visaRequired: Boolean(student.visaRequired),
    automationMode: String(student.automationMode) as StudentProfile["automationMode"],
    defaultStrictness: String(student.defaultStrictness) as StudentProfile["defaultStrictness"],
    bio: typeof student.bio === "string" ? student.bio : "",
    avatarUrl: typeof student.avatarUrl === "string" ? student.avatarUrl : undefined,
    resumeId: typeof student.resumeId === "string" ? student.resumeId : undefined,
    completeProfile: isRecord(student.completeProfile)
      ? {
          headline: asOptionalString(student.completeProfile.headline),
          phone: asOptionalString(student.completeProfile.phone),
          alternateEmail: asOptionalString(student.completeProfile.alternateEmail),
          linkedInUrl: asOptionalString(student.completeProfile.linkedInUrl),
          githubUrl: asOptionalString(student.completeProfile.githubUrl),
          portfolioUrl: asOptionalString(student.completeProfile.portfolioUrl),
          websiteUrl: asOptionalString(student.completeProfile.websiteUrl),
          leetcodeUrl: asOptionalString(student.completeProfile.leetcodeUrl),
          kaggleUrl: asOptionalString(student.completeProfile.kaggleUrl),
          addressLine1: asOptionalString(student.completeProfile.addressLine1),
          addressLine2: asOptionalString(student.completeProfile.addressLine2),
          city: asOptionalString(student.completeProfile.city),
          state: asOptionalString(student.completeProfile.state),
          country: asOptionalString(student.completeProfile.country),
          postalCode: asOptionalString(student.completeProfile.postalCode),
          nationality: asOptionalString(student.completeProfile.nationality),
          pronouns: asOptionalString(student.completeProfile.pronouns),
          gender: asOptionalString(student.completeProfile.gender),
          dateOfBirth: asOptionalString(student.completeProfile.dateOfBirth),
          currentCompany: asOptionalString(student.completeProfile.currentCompany),
          currentTitle: asOptionalString(student.completeProfile.currentTitle),
          totalExperienceYears: asOptionalNumber(student.completeProfile.totalExperienceYears),
          noticePeriodDays: asOptionalNumber(student.completeProfile.noticePeriodDays),
          currentSalaryLpa: asOptionalNumber(student.completeProfile.currentSalaryLpa),
          sponsorshipRequired: asOptionalBoolean(student.completeProfile.sponsorshipRequired),
          openToRelocate: asOptionalBoolean(student.completeProfile.openToRelocate),
          willingToTravel: asOptionalBoolean(student.completeProfile.willingToTravel),
          workAuthorizationCountries: asStringArray(student.completeProfile.workAuthorizationCountries),
          preferredEmploymentTypes: asStringArray(student.completeProfile.preferredEmploymentTypes),
          certifications: asStringArray(student.completeProfile.certifications),
          languages: asStringArray(student.completeProfile.languages),
          achievements: asStringArray(student.completeProfile.achievements),
          educationHistory: asRecordArray(student.completeProfile.educationHistory).map((entry) => ({
            school: String(entry.school ?? ""),
            degree: String(entry.degree ?? ""),
            fieldOfStudy: asOptionalString(entry.fieldOfStudy),
            startYear: asOptionalNumber(entry.startYear),
            endYear: asOptionalNumber(entry.endYear),
            grade: asOptionalString(entry.grade),
            city: asOptionalString(entry.city),
            country: asOptionalString(entry.country)
          })),
          employmentHistory: asRecordArray(student.completeProfile.employmentHistory).map((entry) => ({
            company: String(entry.company ?? ""),
            title: String(entry.title ?? ""),
            startDate: asOptionalString(entry.startDate),
            endDate: asOptionalString(entry.endDate),
            current: asOptionalBoolean(entry.current),
            location: asOptionalString(entry.location),
            summary: asOptionalString(entry.summary)
          })),
          projectHistory: asRecordArray(student.completeProfile.projectHistory).map((entry) => ({
            name: String(entry.name ?? ""),
            role: asOptionalString(entry.role),
            techStack: asOptionalString(entry.techStack),
            summary: asOptionalString(entry.summary),
            url: asOptionalString(entry.url)
          })),
          screeningAnswers: asRecordArray(student.completeProfile.screeningAnswers).map((entry) => ({
            question: String(entry.question ?? ""),
            answer: String(entry.answer ?? "")
          })),
          customFacts: asRecordArray(student.completeProfile.customFacts).map((entry) => ({
            label: String(entry.label ?? ""),
            value: String(entry.value ?? "")
          })),
          eeo: isRecord(student.completeProfile.eeo)
            ? {
                ethnicity: asOptionalString(student.completeProfile.eeo.ethnicity),
                veteranStatus: asOptionalString(student.completeProfile.eeo.veteranStatus),
                disabilityStatus: asOptionalString(student.completeProfile.eeo.disabilityStatus)
              }
            : {}
        }
      : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asOptionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function asOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asRecordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
