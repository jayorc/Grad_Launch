import mongoose, { Schema } from "mongoose";

const answerSchema = new Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true }
  },
  { _id: false }
);

const generatedArtifactsSchema = new Schema(
  {
    tailoredResumeSummary: { type: String, required: true },
    coverLetterExcerpt: { type: String, required: true },
    shortAnswers: { type: [answerSchema], default: [] }
  },
  { _id: false }
);

const applicationSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, index: true },
    jobId: { type: String, required: true, index: true },
    status: { type: String, required: true },
    sourceLabel: { type: String, required: true },
    matchScore: { type: Number, required: true },
    generatedArtifacts: { type: generatedArtifactsSchema, required: true },
    uploadedDocuments: { type: [String], default: [] },
    lastUpdatedAt: { type: String, required: true },
    createdAt: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

applicationSchema.index({ studentId: 1, jobId: 1 });

export const ApplicationModel =
  mongoose.models.Application ?? mongoose.model("Application", applicationSchema);

