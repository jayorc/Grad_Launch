import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../lib/express";
import { requireAuth } from "../middleware/auth-middleware";
import { AgentOrchestratorService } from "../services/agent-orchestrator-service";
import { BrowserAgentAdapterService } from "../services/browser-agent-adapter-service";

export function registerAgentRoutes(app: Express) {
  const adapter = new BrowserAgentAdapterService();
  const orchestrator = new AgentOrchestratorService();

  app.get("/agent/capabilities", requireAuth, async (_request: AuthenticatedRequest, response: Response) => {
    response.json(await adapter.getCapabilities());
  });

  app.get("/agent/control-plane", requireAuth, async (request: AuthenticatedRequest, response: Response) => {
    response.json(await orchestrator.getControlPlaneSnapshot(request.auth?.studentId ?? ""));
  });
}
