import mongoose, { Schema } from "mongoose";

const resumeSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: false, index: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    storagePath: { type: String, required: true },
    extractedText: { type: String, required: false }
  },
  { timestamps: { createdAt: "uploadedAt", updatedAt: false }, versionKey: false }
);

export const ResumeModel = mongoose.models.Resume ?? mongoose.model("Resume", resumeSchema);

