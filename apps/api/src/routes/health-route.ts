import type { Express, Request, Response } from "express";
import { getActiveDataMode } from "../lib/data-mode";

export function registerHealthRoute(app: Express) {
  app.get("/health", (_request: Request, response: Response) => {
    response.json({
      status: "ok",
      service: "gradlaunch-api",
      dataMode: getActiveDataMode()
    });
  });
}
