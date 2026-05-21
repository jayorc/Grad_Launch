import cors from "cors";
import express from "express";
import { getConfig } from "./config/env";
import { registerAgentRoutes } from "./routes/agent-routes";
import { registerApplicationRoutes } from "./routes/application-routes";
import { registerAuthRoutes } from "./routes/auth-routes";
import { registerHealthRoute } from "./routes/health-route";
import { registerJobRoutes } from "./routes/job-routes";
import { registerSearchRoutes } from "./routes/search-routes";
import { registerStudentRoutes } from "./routes/student-routes";

export function createApp() {
  const app = express();
  const config = getConfig();

  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by Access-Control-Allow-Origin.`));
    }
  }));
  app.use(express.json());

  registerHealthRoute(app);
  registerAuthRoutes(app);
  registerAgentRoutes(app);
  registerStudentRoutes(app);
  registerJobRoutes(app);
  registerSearchRoutes(app);
  registerApplicationRoutes(app);

  return app;
}
