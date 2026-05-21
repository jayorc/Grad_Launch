import type { Express, Request, Response } from "express";
import type { CreateApplicationInput } from "@gradlaunch/shared";
import type { AuthenticatedRequest } from "../lib/express";
import { requireAuth } from "../middleware/auth-middleware";
import { ApplicationService } from "../services/application-service";
import { ApplicationRepository } from "../repositories/application-repository";

export function registerApplicationRoutes(app: Express) {
  const applications = new ApplicationService();
  const repository = new ApplicationRepository();

  app.get("/applications", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    response.json(await repository.listByStudent(request.auth?.studentId ?? ""));
  });

  app.get("/applications/:applicationId/runs", requireAuth, async (request: Request, response: Response) => {
    const applicationId = normalizeRouteParam(request.params.applicationId);
    const application = await repository.getById(applicationId);

    if (!application || application.studentId !== (request as AuthenticatedRequest).auth?.studentId) {
      response.status(404).json({ message: "Application not found." });
      return;
    }

    response.json(await repository.listRunsByApplication(applicationId));
  });

  app.post("/applications", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      const result = await applications.create({
        studentId: request.auth?.studentId ?? "",
        jobId: String(request.body?.jobId ?? ""),
        mode: normalizeApplicationMode(request.body?.mode)
      });
      response.status(201).json(result);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to create application." });
    }
  });

  app.post("/applications/:applicationId/submit", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      const result = await applications.submit({
        applicationId: normalizeRouteParam(request.params.applicationId),
        studentId: request.auth?.studentId ?? "",
        intent: request.body?.intent === "auto_submit" ? "auto_submit" : "review_submit",
        reviewedFields: Array.isArray(request.body?.reviewedFields)
          ? request.body.reviewedFields.map((field: Record<string, unknown>) => ({
              label: String(field.label ?? ""),
              value: String(field.value ?? "")
            }))
          : [],
        confirmExternalSubmit: request.body?.confirmExternalSubmit === true
      });
      response.json(result);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to submit application." });
    }
  });

  app.post("/applications/:applicationId/resume-browser", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      const result = await applications.resumeInBrowser({
        studentId: request.auth?.studentId ?? "",
        applicationId: normalizeRouteParam(request.params.applicationId),
        submit: request.body?.submit === true
      });
      response.json(result);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to resume this browser application run." });
    }
  });

  app.post("/jobs/:jobId/fill-browser", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      const result = await applications.fillJobInBrowser({
        studentId: request.auth?.studentId ?? "",
        jobId: normalizeRouteParam(request.params.jobId),
        submit: request.body?.submit === true
      });
      response.json(result);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to fill this job in Chrome." });
    }
  });
}

function normalizeRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

function normalizeApplicationMode(value: unknown): CreateApplicationInput["mode"] {
  if (value === "autofill" || value === "autopilot") {
    return value;
  }

  return "draft";
}
