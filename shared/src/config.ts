import { z } from "zod";
import dotenv from "dotenv";
import { existsSync } from "fs";

// Load .env.local first, then fall back to .env
if (existsSync(".env.local")) {
  dotenv.config({ path: ".env.local" });
} else {
  dotenv.config();
}

const configSchema = z.object({
  // Database (required)
  DATABASE_URL: z.string().url().describe("MySQL database connection URL"),

  // Redis (required)
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  QUEUE_NAME: z.string().default("vine-products"),

  // Amazon credentials (required)
  AMAZON_EMAIL: z.string().email(),
  AMAZON_PASSWORD: z.string().min(1),
  AMAZON_VINE_BASE_URL: z.string().url().default("https://www.amazon.com/vine"),
  AMAZON_VINE_ENCORE_URL: z
    .string()
    .url()
    .default("https://www.amazon.com/vine/vine-items?queue=encore"),
  AMAZON_VINE_SIGNIN_URL: z.string().url(),

  // Playwright configuration
  PLAYWRIGHT_HEADLESS: z
    .string()
    .transform((value) => value.toLowerCase() === "true" || value === "1")
    .or(z.boolean())
    .default(false),
  PLAYWRIGHT_USER_DATA_DIR: z.string().optional(),
  PLAYWRIGHT_CHROME_EXECUTABLE_PATH: z.string().optional(),
  PLAYWRIGHT_CDP_ENDPOINT: z.string().url().optional().describe("Chrome DevTools Protocol endpoint (e.g., http://localhost:9222)"),

  // API configuration
  API_PORT: z.coerce.number().int().positive().default(3000),

  // Rate limiting
  RATE_LIMIT_DELAY_BETWEEN_PAGES_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(10_000),
  RATE_LIMIT_DELAY_BETWEEN_REQUESTS_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(20), // 20ms delay between tab openings
  
  
  // Worker configuration
  PRODUCT_WORKER_ID: z.coerce.number().int().positive().optional(),
  PRODUCT_WORKER_TOTAL: z.coerce.number().int().positive().optional(),
  GENERAL_WORKER_ID: z.coerce.number().int().positive().optional(),
  GENERAL_WORKER_TOTAL: z.coerce.number().int().positive().optional(),
  TABS_PER_BATCH: z.coerce.number().int().positive().default(50), // Configurable batch size
  TABS_PER_BATCH_PER_WORKER: z.coerce.number().int().positive().default(25), // Tabs each general worker opens per batch
  ROTATION_BATCH_SIZE: z.coerce.number().int().positive().default(50).describe("Number of pages to assign per rotation cycle"), // Pages per rotation cycle
  ENABLE_ROUND_ROBIN_ROTATION: z
    .string()
    .transform((value) => value.toLowerCase() === "true" || value === "1")
    .or(z.boolean())
    .default(false)
    .describe("Enable round-robin IP rotation (Server 1 → 2 → 3 → 1)"),

  // Proxy configuration (for IP rotation)
  USE_PROXY: z
    .string()
    .transform((value) => value.toLowerCase() === "true" || value === "1")
    .or(z.boolean())
    .default(false),
  PROXY_SERVER: z.string().optional().describe("Proxy server URL (e.g., http://proxy.example.com:8080)"),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),

  // Logging
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.string().default("production"),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid configuration");
}

export const config = parsed.data;

