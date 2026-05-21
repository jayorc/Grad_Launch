import type { Express, Request, Response } from "express";
import type { AuthenticatedRequest } from "../lib/express";
import { requireAuth } from "../middleware/auth-middleware";
import { StudentRepository } from "../repositories/student-repository";
import { DashboardService } from "../services/dashboard-service";

export function registerStudentRoutes(app: Express) {
  const students = new StudentRepository();
  const dashboard = new DashboardService();

  app.get("/students/me", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    const student = await students.getById(request.auth?.studentId ?? "");
    response.json(student);
  });

  app.get("/students/me/dashboard", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    response.json(await dashboard.getReport(request.auth?.studentId ?? ""));
  });
}
