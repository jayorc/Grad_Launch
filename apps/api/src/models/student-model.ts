import mongoose, { Schema } from "mongoose";

const studentSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    fullName: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    degree: { type: String, required: true },
    graduationYear: { type: Number, required: true },
    targetRoles: { type: [String], default: [] },
    preferredLocations: { type: [String], default: [] },
    workModes: { type: [String], default: ["remote", "hybrid"] },
    skills: { type: [String], default: [] },
    expectedSalaryLpa: { type: Number, required: false },
    visaRequired: { type: Boolean, default: false },
    automationMode: { type: String, default: "full_autopilot" },
    defaultStrictness: { type: String, default: "balanced" },
    bio: { type: String, default: "" },
    avatarUrl: { type: String, required: false },
    resumeId: { type: String, required: false }
  },
  { timestamps: true, versionKey: false }
);

export const StudentModel = mongoose.models.Student ?? mongoose.model("Student", studentSchema);
