import mongoose from "mongoose";

let connectionPromise: Promise<typeof mongoose> | null = null;

export function connectToDatabase(uri: string) {
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(uri, {
      serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000),
      connectTimeoutMS: Number(process.env.MONGODB_CONNECT_TIMEOUT_MS ?? 5000)
    });
  }

  return connectionPromise;
}
