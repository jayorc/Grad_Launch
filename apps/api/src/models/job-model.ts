import mongoose, { Schema } from "mongoose";

const jobSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    company: { type: String, required: true },
    location: { type: String, required: true },
    workMode: { type: String, required: true },
    minExperience: { type: Number, required: true },
    maxExperience: { type: Number, required: true },
    degreeRequirements: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    description: { type: String, required: true },
    sourceType: { type: String, required: true },
    sourceUrl: { type: String, required: true },
    createdAt: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

jobSchema.index({ sourceUrl: 1 }, { unique: true });

export const JobModel = mongoose.models.Job ?? mongoose.model("Job", jobSchema);

