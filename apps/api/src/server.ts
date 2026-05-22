import dotenv from "dotenv";
import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { seedDemoData } from "./bootstrap/seed-demo-data";
import { getConfig } from "./config/env";
import { connectToDatabase, disconnectFromDatabase } from "./lib/db";
import { setActiveDataMode } from "./lib/data-mode";
import { resetMemoryDatabase } from "./repositories/in-memory-db";
import { AgentWorkerRuntime } from "./services/agent-worker-runtime";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const projectRoot = resolve(currentDir, "../../..");

dotenv.config({ path: resolve(projectRoot, ".env") });

process.on("unhandledRejection", (reason) => {
  console.error("[GradLaunch] Unhandled rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[GradLaunch] Uncaught exception", error);
});

async function startServer() {
  const config = getConfig();
  await initializeDataStore(config);

  const app = createApp();
  const runtime = new AgentWorkerRuntime();
  let server: Server | undefined;
  let shuttingDown = false;

  runtime.start();

  server = app.listen(config.port, () => {
    console.log(`GradLaunch API listening on http://localhost:${config.port}`);
    console.log("[GradLaunch] Agent worker runtime started.");
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[GradLaunch] Received ${signal}. Shutting down API gracefully...`);
    runtime.stop();

    const forceExitTimer = setTimeout(() => {
      console.warn("[GradLaunch] Graceful shutdown timed out. Forcing exit.");
      process.exit(1);
    }, 8000);

    forceExitTimer.unref();

    try {
      await new Promise<void>((resolvePromise) => {
        if (!server) {
          resolvePromise();
          return;
        }

        server.close(() => {
          resolvePromise();
        });
      });
      await disconnectFromDatabase().catch((error) => {
        console.warn("[GradLaunch] Failed to disconnect Mongo cleanly.", error);
      });
      console.log("[GradLaunch] Shutdown complete.");
      process.exit(0);
    } catch (error) {
      console.error("[GradLaunch] Shutdown failed.", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

startServer().catch((error) => {
  console.error("Failed to start GradLaunch API", error);
  process.exit(1);
});

async function initializeDataStore(config: ReturnType<typeof getConfig>) {
  if (config.dataMode === "memory") {
    setActiveDataMode("memory");
    await resetMemoryDatabase(config.seedDemoData);
    console.log("[GradLaunch] Starting in memory mode.");
    return;
  }

  if (!config.mongoUri) {
    setActiveDataMode("memory");
    await resetMemoryDatabase(config.seedDemoData);
    console.warn("[GradLaunch] MONGODB_URI not set. Falling back to memory mode.");
    return;
  }

  try {
    await connectToDatabase(config.mongoUri);
    setActiveDataMode("mongo");

    if (config.seedDemoData) {
      await seedDemoData();
    }
  } catch (error) {
    if (config.dataMode !== "auto") {
      throw error;
    }

    setActiveDataMode("memory");
    await resetMemoryDatabase(config.seedDemoData);
    console.warn("[GradLaunch] MongoDB unavailable. Falling back to memory mode.");
    console.warn(error);
  }
}
