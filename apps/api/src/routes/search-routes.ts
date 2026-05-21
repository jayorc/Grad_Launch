import type { Express, Request, Response } from "express";
import type { MatchStrictness } from "@gradlaunch/shared";
import type { AuthenticatedRequest } from "../lib/express";
import { requireAuth } from "../middleware/auth-middleware";
import { SearchService } from "../services/search-service";

export function registerSearchRoutes(app: Express) {
  const searchService = new SearchService();

  app.post("/search-sessions", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      const result = await searchService.startSession({
        studentId: request.auth?.studentId ?? "",
        durationMinutes: Number(request.body?.durationMinutes ?? 5),
        strictness: normalizeStrictness(request.body?.strictness)
      });
      response.status(201).json(result);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to start search session." });
    }
  });
}

function normalizeStrictness(value: unknown): MatchStrictness {
  if (value === "broad" || value === "strict") {
    return value;
  }

  return "balanced";
}
