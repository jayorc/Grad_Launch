import type { RequestedDataMode } from "../lib/data-mode";

const required = ["JWT_SECRET"] as const;

type RequiredKey = "MONGODB_URI" | (typeof required)[number];

export type AppConfig = {
  port: number;
  mongoUri?: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  seedDemoData: boolean;
  dataMode: RequestedDataMode;
};

export function getConfig(): AppConfig {
  const dataMode = normalizeDataMode(process.env.DATA_MODE);

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  if (dataMode === "mongo" && !process.env.MONGODB_URI) {
    throw new Error("Missing required environment variable: MONGODB_URI");
  }

  return {
    port: Number(process.env.PORT ?? 4000),
    mongoUri: process.env.MONGODB_URI,
    jwtSecret: process.env.JWT_SECRET as string,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGIN),
    seedDemoData: process.env.SEED_DEMO_DATA === "true",
    dataMode
  };
}

export function getRequiredEnv(key: RequiredKey): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function normalizeDataMode(value: string | undefined): RequestedDataMode {
  if (value === "mongo" || value === "memory") {
    return value;
  }

  return "auto";
}

function parseCorsOrigins(value: string | undefined) {
  const defaultOrigins = ["http://localhost:3000", "http://localhost:3001"];
  const rawValue = value?.trim();

  if (!rawValue) {
    return defaultOrigins;
  }

  const origins = rawValue
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([...defaultOrigins, ...origins])];
}
