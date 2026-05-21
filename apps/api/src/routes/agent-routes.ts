import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../lib/express";
import { requireAuth } from "../middleware/auth-middleware";
import { AIHawkAdapterService } from "../services/aihawk-adapter-service";

export function registerAgentRoutes(app: Express) {
  const adapter = new AIHawkAdapterService();

  app.get("/agent/capabilities", requireAuth, async (_request: AuthenticatedRequest, response: Response) => {
    response.json(await adapter.getCapabilities());
  });
}
