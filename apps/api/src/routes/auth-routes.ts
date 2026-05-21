import type { Express, Request, Response } from "express";
import { requireAuth } from "../middleware/auth-middleware";
import { resumeUpload } from "../lib/upload";
import { AuthService } from "../services/auth-service";
import { ResumeService } from "../services/resume-service";
import type { AuthenticatedRequest } from "../lib/express";

export function registerAuthRoutes(app: Express) {
  const auth = new AuthService();
  const resumes = new ResumeService();

  app.post("/auth/login", async (request: Request, response: Response) => {
    try {
      response.status(200).json(await auth.login(request.body));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to login." });
    }
  });

  app.post("/auth/register", async (request: Request, response: Response) => {
    try {
      response.status(201).json(await auth.register(request.body));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to register." });
    }
  });

  app.post("/auth/resume-draft", resumeUpload.single("resume"), async (request: Request, response: Response) => {
    try {
      if (!request.file) {
        response.status(400).json({ message: "Resume file is required." });
        return;
      }

      response.status(201).json(await resumes.createDraftFromUpload(request.file));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to parse resume." });
    }
  });

  app.get("/auth/session", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      response.json(await auth.getSessionFromToken(request.auth?.token ?? ""));
    } catch (error) {
      response.status(404).json({ message: error instanceof Error ? error.message : "Session not found." });
    }
  });

  app.post("/auth/logout", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    await auth.logout(request.auth?.token ?? "");
    response.status(204).send();
  });

  app.put("/students/me/profile", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    try {
      response.json(await auth.updateProfile(request.auth?.studentId ?? "", request.body));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : "Unable to update profile." });
    }
  });

  app.post(
    "/students/me/resume",
    requireAuth,
    resumeUpload.single("resume"),
    async (request: AuthenticatedRequest, response: Response) => {
      try {
        if (!request.file) {
          response.status(400).json({ message: "Resume file is required." });
          return;
        }

        response.status(201).json(await resumes.uploadForStudent(request.auth?.studentId ?? "", request.file));
      } catch (error) {
        response.status(400).json({ message: error instanceof Error ? error.message : "Unable to upload resume." });
      }
    }
  );
}
