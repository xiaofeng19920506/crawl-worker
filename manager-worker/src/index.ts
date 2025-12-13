import { config, logger, redisConnection, REDIS_KEY_TOTAL_PAGES, REDIS_KEY_TOTAL_PRODUCTS, REDIS_KEY_GENERAL_WORKER_HEARTBEAT, REDIS_KEY_GENERAL_WORKER_PAGES, REDIS_KEY_GENERAL_WORKER_COMPLETE, REDIS_KEY_GENERAL_WORKER_PROCESSING, REDIS_KEY_MANAGER_TRIGGER, REDIS_KEY_WORKER_LOCK } from "shared";
import { setTimeout as delay } from "node:timers/promises";

// Manager worker - controls and assigns work to general workers

const detectActiveGeneralWorkers = async (): Promise<number[]> => {
  // Check for active general workers by looking for heartbeats
  // A worker is considered active if it has a heartbeat within the last 60 seconds
  const HEARTBEAT_TIMEOUT_MS = 60000; // 60 seconds
  const now = Date.now();
  const activeWorkers: number[] = [];
  
  // Check workers 1-20 (reasonable max)
  for (let workerId = 1; workerId <= 20; workerId++) {
    const heartbeatStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_HEARTBEAT(workerId));
    if (heartbeatStr) {
      const heartbeatTime = parseInt(heartbeatStr, 10);
      if (!isNaN(heartbeatTime) && (now - heartbeatTime) < HEARTBEAT_TIMEOUT_MS) {
        activeWorkers.push(workerId);
      }
    }
  }
  
  // Sort by worker ID for consistent ordering
  activeWorkers.sort((a, b) => a - b);
  
  return activeWorkers;
};

const distributePagesToGeneralWorkers = async (totalPages: number): Promise<void> => {
  // Detect active general workers automatically
  const activeWorkers = await detectActiveGeneralWorkers();
  
  if (activeWorkers.length === 0) {
    logger.warn("No active general workers detected! Waiting for workers to start...");
    return;
  }
  
  logger.info({ activeWorkers, count: activeWorkers.length, totalPages }, "Distributing pages to general workers");
  
  // Distribute pages evenly among active general workers
  const pagesPerWorker = Math.ceil(totalPages / activeWorkers.length);
  
  for (let i = 0; i < activeWorkers.length; i++) {
    const workerId = activeWorkers[i];
    const startPage = i * pagesPerWorker + 1;
    const endPage = Math.min((i + 1) * pagesPerWorker, totalPages);
    
    // Assign page range to this general worker
    const pageRange = { start: startPage, end: endPage };
    await redisConnection.set(REDIS_KEY_GENERAL_WORKER_PAGES(workerId), JSON.stringify(pageRange));
    await redisConnection.del(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId)); // Clear completion flag
    
    logger.info({ workerId, startPage, endPage, pages: endPage - startPage + 1 }, "Assigned page range to general worker");
  }
  
  logger.info({ totalPages, activeWorkers, pagesPerWorker }, "✅ Pages distributed to all general workers");
};

const checkAndAssignWork = async (): Promise<void> => {
  try {
    // Get total pages from Redis (discovered by general workers)
    const totalPagesStr = await redisConnection.get(REDIS_KEY_TOTAL_PAGES);
    if (!totalPagesStr) {
      logger.info("Total pages not yet discovered. Waiting for general workers to discover pages...");
      return;
    }
    
    const totalPages = parseInt(totalPagesStr, 10);
    if (isNaN(totalPages) || totalPages <= 0) {
      logger.warn({ totalPagesStr }, "Invalid total pages value");
      return;
    }
    
    // Check if we need to assign work
    const activeWorkers = await detectActiveGeneralWorkers();
    if (activeWorkers.length === 0) {
      logger.info("No active general workers. Waiting...");
      return;
    }
    
    // Check if any general worker needs work assigned
    let needsAssignment = false;
    for (const workerId of activeWorkers) {
      const pagesStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_PAGES(workerId));
      if (!pagesStr) {
        needsAssignment = true;
        break;
      }
      
      // Check if worker is currently processing (don't reassign if processing)
      const processingStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_PROCESSING(workerId));
      if (processingStr === "1") {
        logger.debug({ workerId }, "Worker is currently processing, skipping reassignment");
        continue; // Don't reassign if worker is processing
      }
      
      // Check if worker has completed its assigned range
      const completeStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId));
      if (completeStr === "1") {
        // Worker completed, reassign if there's more work
        const pagesStr2 = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_PAGES(workerId));
        if (pagesStr2) {
          const range = JSON.parse(pagesStr2) as { start: number; end: number };
          if (range.end < totalPages) {
            needsAssignment = true;
            break;
          }
        }
      }
    }
    
    if (needsAssignment) {
      logger.info({ totalPages, activeWorkers }, "Assigning/reassigning pages to general workers");
      await distributePagesToGeneralWorkers(totalPages);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, "Error in checkAndAssignWork");
  }
};

const main = async (): Promise<void> => {
  // Check for duplicate manager worker (only one manager should run)
  try {
    const lockKey = REDIS_KEY_WORKER_LOCK("manager", 1);
    const existingLock = await redisConnection.get(lockKey);
    
    if (existingLock) {
      const lockTime = parseInt(existingLock, 10);
      const now = Date.now();
      // If lock is older than 30 seconds, assume previous manager crashed
      if (now - lockTime < 30000) {
        logger.error({ existingLockTime: new Date(lockTime).toISOString() }, "❌ Another Manager Worker is already running!");
        logger.error("Please stop the duplicate manager worker");
        process.exit(1);
      }
    }
    
    // Set lock with current timestamp
    await redisConnection.set(lockKey, Date.now().toString());
  } catch (error) {
    logger.warn({ error }, "Failed to check for duplicate manager, continuing anyway");
  }
  
  logger.info("🚀 Manager Worker starting...");
  logger.info("Standalone manager - detects active general workers and assigns page ranges to them");
  logger.info({ redisUrl: config.REDIS_URL }, "Connecting to Redis for coordination");
  
  // Test Redis connection
  try {
    await redisConnection.ping();
    logger.info("✅ Redis connection successful");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, redisUrl: config.REDIS_URL }, "Failed to connect to Redis. Make sure Redis is running and accessible.");
    logger.error("Manager worker requires Redis connection to coordinate general workers.");
    process.exit(1);
  }
  
  // Send initial assignment check
  await checkAndAssignWork();
  
  // Set up continuous polling to check for work assignment every 5 seconds
  const POLL_INTERVAL = 5000; // 5 seconds
  
  const pollForWork = async () => {
    try {
      await checkAndAssignWork();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "Error in work assignment check - will retry on next poll");
      // Continue polling even on error - Redis connection issues are transient
    }
    
    // Schedule next poll
    setTimeout(pollForWork, POLL_INTERVAL);
  };
  
  // Start polling
  setTimeout(pollForWork, POLL_INTERVAL);
  logger.info({ interval: POLL_INTERVAL }, "Started continuous polling for work assignment");
  logger.info("Manager worker is running standalone - can be deployed on any server with Redis access");
  
  // Keep process alive
  const shutdown = async (): Promise<void> => {
    logger.info("Manager worker shutting down gracefully");
    try {
      await redisConnection.del(REDIS_KEY_WORKER_LOCK("manager", 1)); // Release lock
      await redisConnection.quit();
    } catch (error) {
      // Ignore errors on shutdown
    }
    process.exit(0);
  };
  
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main().catch((error) => {
  logger.error({ error }, "Manager worker failed to start");
  process.exit(1);
});
