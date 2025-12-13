import { PrismaClient } from "@prisma/client";
import { logger } from "../logger.js";

let db: PrismaClient | null = null;

export const getDb = (): PrismaClient => {
  if (!db) {
    db = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    });

    // Handle graceful shutdown
    process.on("beforeExit", async () => {
      await db?.$disconnect();
    });
  }

  return db;
};

export const initDb = async (): Promise<void> => {
  const database = getDb();
  try {
    await database.$connect();
    logger.info("Database connected successfully");
  } catch (error) {
    logger.error({ error }, "Failed to connect to database");
    throw error;
  }
};

