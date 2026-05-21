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
    resumeId: typeof student.resumeId === "string" ? student.resumeId : undefined
  };
}
