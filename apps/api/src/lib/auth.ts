import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getRequiredEnv } from "../config/env";

export type AuthTokenPayload = {
  sessionId: string;
  studentId: string;
  email: string;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function signSessionToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, getRequiredEnv("JWT_SECRET"), {
    expiresIn: (process.env.JWT_EXPIRES_IN ?? "7d") as jwt.SignOptions["expiresIn"]
  });
}

export function verifySessionToken(token: string): AuthTokenPayload {
  return jwt.verify(token, getRequiredEnv("JWT_SECRET")) as AuthTokenPayload;
}
