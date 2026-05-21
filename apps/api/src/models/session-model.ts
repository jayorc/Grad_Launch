import mongoose, { Schema } from "mongoose";

const sessionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, index: true },
    email: { type: String, required: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

export const SessionModel = mongoose.models.Session ?? mongoose.model("Session", sessionSchema);

