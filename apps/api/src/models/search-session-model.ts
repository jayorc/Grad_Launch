import mongoose, { Schema } from "mongoose";

const searchSessionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, index: true },
    durationMinutes: { type: Number, required: true },
    strictness: { type: String, required: true },
    startedAt: { type: String, required: true },
    completedAt: { type: String, required: true },
    resultJobIds: { type: [String], default: [] },
    summary: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

export const SearchSessionModel =
  mongoose.models.SearchSession ?? mongoose.model("SearchSession", searchSessionSchema);

