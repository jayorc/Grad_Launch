import type { Request } from "express";

export type AuthenticatedRequest = Request & {
  auth?: {
    studentId: string;
    sessionId: string;
    email: string;
    token: string;
  };
};

export function getAuthenticatedUser(request: AuthenticatedRequest) {
  if (!request.auth?.studentId) {
    throw new Error("Unauthorized");
  }

  return request.auth;
}

