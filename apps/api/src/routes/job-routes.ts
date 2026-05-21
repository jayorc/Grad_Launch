import type { Express, Request, Response } from "express";
import type { AuthenticatedRequest } from "../lib/express";
import { requireAuth } from "../middleware/auth-middleware";
import { JobRepository } from "../repositories/job-repository";
import { JobIntakeService } from "../services/job-intake-service";

export function registerJobRoutes(app: Express) {
  const jobs = new JobRepository();
  const intake = new JobIntakeService();

  app.get("/jobs", requireAuth, async (_request: Request, response: Response) => {
    response.json(await jobs.list());
  });

  app.post("/jobs/intake-url", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      const job = await intake.intakeFromUrl({
        studentId: request.auth?.studentId ?? "",
        jobUrl: String(request.body?.jobUrl ?? "")
      });
      response.status(201).json(job);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to intake job URL." });
    }
  });
}
