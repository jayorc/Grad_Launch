import type { NextFunction, Response } from "express";
import { verifySessionToken } from "../lib/auth";
import type { AuthenticatedRequest } from "../lib/express";
import { AuthRepository } from "../repositories/auth-repository";

export async function requireAuth(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  try {
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      response.status(401).json({ message: "Missing authorization token." });
      return;
    }

    const token = authorization.slice("Bearer ".length);
    const payload = verifySessionToken(token);
    const authRepository = new AuthRepository();
    const session = await authRepository.getSessionById(payload.sessionId);

    if (!session || session.token !== token) {
      response.status(401).json({ message: "Session not found or expired." });
      return;
    }

    request.auth = {
      studentId: payload.studentId,
      sessionId: payload.sessionId,
      email: payload.email,
      token
    };

    next();
  } catch (_error) {
    response.status(401).json({ message: "Invalid or expired token." });
  }
}

