import mongoose, { Schema } from "mongoose";

const accountSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

export const AccountModel = mongoose.models.Account ?? mongoose.model("Account", accountSchema);

