import { Queue, Worker, Job, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";

const connectionOptions = {
  maxRetriesPerRequest: null,
} as const;

const createRedisConnection = (): Redis => {
  return new Redis(config.REDIS_URL, connectionOptions);
};

export const redisConnection = createRedisConnection();

// Redis keys
export const REDIS_KEY_TOTAL_PAGES = "vine:total-pages";
export const REDIS_KEY_TOTAL_PRODUCTS = "vine:total-products";
export const REDIS_KEY_PRODUCT_URLS = "vine:product-urls";
export const REDIS_KEY_CRAWL_TRIGGER = "vine:crawl-trigger";
export const REDIS_KEY_LAST_PRODUCT_COUNT = "vine:last-product-count";
export const REDIS_KEY_TABS_READY = "vine:tabs-ready"; // Set to "1" when general worker has opened a batch of tabs
export const REDIS_KEY_CURRENT_BATCH_START = "vine:current-batch-start"; // Start page of current batch
export const REDIS_KEY_CURRENT_BATCH_END = "vine:current-batch-end"; // End page of current batch
export const REDIS_KEY_BATCH_COMPLETE = "vine:batch-complete"; // Set to "1" when all product workers finish current batch
export const REDIS_KEY_WORKER_PAGES = (workerId: number) => `vine:worker-${workerId}-pages`; // Pages assigned to a specific product worker (JSON array)
export const REDIS_KEY_WORKER_COMPLETE = (workerId: number) => `vine:worker-${workerId}-complete`; // Worker completion status
export const REDIS_KEY_WORKER_HEARTBEAT = (workerId: number) => `vine:worker-${workerId}-heartbeat`; // Worker heartbeat timestamp
export const REDIS_KEY_PENDING_PAGES = "vine:pending-pages"; // Pages waiting to be assigned (JSON array)
export const REDIS_KEY_ASSIGNED_PAGES = "vine:assigned-pages"; // Pages currently assigned (JSON array)
export const REDIS_KEY_GENERAL_WORKER_HEARTBEAT = (workerId: number) => `vine:general-worker-${workerId}-heartbeat`; // General worker heartbeat timestamp
export const REDIS_KEY_GENERAL_WORKER_PAGES = (workerId: number) => `vine:general-worker-${workerId}-pages`; // Page range assigned to a general worker (JSON: {start, end})
export const REDIS_KEY_GENERAL_WORKER_COMPLETE = (workerId: number) => `vine:general-worker-${workerId}-complete`; // General worker completion status
export const REDIS_KEY_GENERAL_WORKER_PROCESSING = (workerId: number) => `vine:general-worker-${workerId}-processing`; // General worker processing lock
export const REDIS_KEY_MANAGER_TRIGGER = "vine:manager-trigger"; // Trigger for manager to assign work
export const REDIS_KEY_ROTATION_INDEX = "vine:rotation-index"; // Current rotation index for round-robin assignment
export const REDIS_KEY_LAST_ASSIGNED_PAGE = "vine:last-assigned-page"; // Last page number assigned in rotation
export const REDIS_KEY_AMAZON_COOKIES = "vine:amazon-cookies"; // Shared Amazon session cookies (JSON array)
export const REDIS_KEY_AMAZON_SESSION_VALID = "vine:amazon-session-valid"; // Session validity flag
export const REDIS_KEY_WORKER_LOCK = (workerType: "manager" | "general" | "product", workerId: number) => `vine:lock:${workerType}-${workerId}`; // Worker process lock to prevent duplicates

export const queueEvents = new QueueEvents(config.QUEUE_NAME, {
  connection: createRedisConnection(),
});

export const productsQueue = new Queue(config.QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  },
});

export type ProductJobData = {
  url: string;
  pageNumber: number;
  asin?: string;
};

export const createWorker = (
  processor: (job: Job<ProductJobData>) => Promise<void>
): Worker<ProductJobData> => {
  return new Worker(config.QUEUE_NAME, processor, {
    connection: createRedisConnection(),
    concurrency: 1,
    limiter: {
      max: 1,
      duration: 1000,
    },
  });
};

export const closeQueueResources = async (): Promise<void> => {
  await Promise.all([queueEvents.close(), redisConnection.quit()]);
};

