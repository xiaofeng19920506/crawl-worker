import { config, logger, redisConnection, REDIS_KEY_TOTAL_PAGES, REDIS_KEY_TOTAL_PRODUCTS, REDIS_KEY_GENERAL_WORKER_HEARTBEAT, REDIS_KEY_GENERAL_WORKER_PAGES, REDIS_KEY_GENERAL_WORKER_COMPLETE, REDIS_KEY_GENERAL_WORKER_PROCESSING, REDIS_KEY_MANAGER_TRIGGER, REDIS_KEY_WORKER_LOCK, REDIS_KEY_ROTATION_INDEX, REDIS_KEY_LAST_ASSIGNED_PAGE } from "shared";
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

// Round-robin rotation: Assign work in batches, rotating through servers
const distributePagesRoundRobin = async (totalPages: number): Promise<void> => {
  const activeWorkers = await detectActiveGeneralWorkers();
  
  if (activeWorkers.length === 0) {
    logger.warn("No active general workers detected! Waiting for workers to start...");
    return;
  }
  
  // Get current rotation state
  const rotationIndexStr = await redisConnection.get(REDIS_KEY_ROTATION_INDEX);
  const lastAssignedPageStr = await redisConnection.get(REDIS_KEY_LAST_ASSIGNED_PAGE);
  
  // Parse and validate rotation state values
  // If Redis contains invalid data, parseInt returns NaN, which we need to handle
  let rotationIndex = 0;
  if (rotationIndexStr) {
    const parsed = parseInt(rotationIndexStr, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      rotationIndex = parsed;
    } else {
      logger.warn({ invalidValue: rotationIndexStr }, "Invalid rotation index in Redis, resetting to 0");
      await redisConnection.set(REDIS_KEY_ROTATION_INDEX, "0");
    }
  }
  
  // Validate rotationIndex is within bounds of current active workers
  // If a worker died and was removed, rotationIndex might be out of bounds
  // Reset to 0 if it's invalid to prevent incorrect worker assignment
  if (rotationIndex >= activeWorkers.length) {
    logger.warn({ 
      rotationIndex, 
      activeWorkersCount: activeWorkers.length,
      activeWorkers 
    }, "Rotation index out of bounds (worker may have died), resetting to 0");
    rotationIndex = 0;
    await redisConnection.set(REDIS_KEY_ROTATION_INDEX, "0");
  }
  
  let lastAssignedPage = 0;
  if (lastAssignedPageStr) {
    const parsed = parseInt(lastAssignedPageStr, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      lastAssignedPage = parsed;
    } else {
      logger.warn({ invalidValue: lastAssignedPageStr }, "Invalid last assigned page in Redis, resetting to 0");
      await redisConnection.set(REDIS_KEY_LAST_ASSIGNED_PAGE, "0");
    }
  }
  
  // If we've completed all pages, reset rotation and clear all completion flags
  // This prevents redundant reassignment on the same invocation
  if (lastAssignedPage >= totalPages) {
    logger.info({ totalPages, lastAssignedPage }, "All pages assigned, resetting rotation");
    rotationIndex = 0;
    lastAssignedPage = 0;
    await redisConnection.set(REDIS_KEY_ROTATION_INDEX, "0");
    await redisConnection.set(REDIS_KEY_LAST_ASSIGNED_PAGE, "0");
    
    // Clear all active workers' completion flags and page assignments to prevent stale data
    // This ensures that when rotation resets, no worker has stale flags or assignments that would
    // prevent the next rotation cycle from starting properly
    for (const workerId of activeWorkers) {
      await redisConnection.del(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId));
      await redisConnection.del(REDIS_KEY_GENERAL_WORKER_PAGES(workerId));
    }
    logger.info({ clearedWorkers: activeWorkers.length }, "Cleared all workers' completion flags and page assignments after rotation reset");
    
    // Return early to prevent immediate reassignment
    // The next invocation will start from the beginning
    return;
  }
  
  // Get next worker in rotation
  const workerId = activeWorkers[rotationIndex % activeWorkers.length];
  const batchSize = config.ROTATION_BATCH_SIZE;
  const startPage = lastAssignedPage + 1;
  const endPage = Math.min(startPage + batchSize - 1, totalPages);
  
  // Additional safety check (shouldn't be needed after the early return above, but kept for safety)
  if (startPage > totalPages) {
    logger.info({ startPage, totalPages }, "All pages have been assigned");
    return;
  }
  
  // Assign batch to current worker in rotation
  const pageRange = { start: startPage, end: endPage };
  await redisConnection.set(REDIS_KEY_GENERAL_WORKER_PAGES(workerId), JSON.stringify(pageRange));
  await redisConnection.del(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId)); // Clear completion flag
  
  // Update rotation state
  const nextRotationIndex = (rotationIndex + 1) % activeWorkers.length;
  await redisConnection.set(REDIS_KEY_ROTATION_INDEX, nextRotationIndex.toString());
  await redisConnection.set(REDIS_KEY_LAST_ASSIGNED_PAGE, endPage.toString());
  
  logger.info({ 
    workerId, 
    startPage, 
    endPage, 
    pages: endPage - startPage + 1,
    rotationIndex: rotationIndex + 1,
    nextWorker: activeWorkers[nextRotationIndex],
    remainingPages: totalPages - endPage
  }, "✅ Assigned batch to worker (round-robin rotation)");
};

// Original distribution: Assign all pages evenly at once
const distributePagesEvenly = async (totalPages: number): Promise<void> => {
  const activeWorkers = await detectActiveGeneralWorkers();
  
  if (activeWorkers.length === 0) {
    logger.warn("No active general workers detected! Waiting for workers to start...");
    return;
  }
  
  logger.info({ activeWorkers, count: activeWorkers.length, totalPages }, "Distributing pages evenly to all general workers");
  
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

const distributePagesToGeneralWorkers = async (totalPages: number): Promise<void> => {
  if (config.ENABLE_ROUND_ROBIN_ROTATION) {
    await distributePagesRoundRobin(totalPages);
  } else {
    await distributePagesEvenly(totalPages);
  }
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
    
    // Check if we need to assign work
    let needsAssignment = false;
    
    if (config.ENABLE_ROUND_ROBIN_ROTATION) {
      // Round-robin mode: Check if any worker completed and there's more work
      const lastAssignedPageStr = await redisConnection.get(REDIS_KEY_LAST_ASSIGNED_PAGE);
      
      // Parse and validate lastAssignedPage (similar to totalPages validation)
      let lastAssignedPage = 0;
      if (lastAssignedPageStr) {
        const parsed = parseInt(lastAssignedPageStr, 10);
        if (!isNaN(parsed) && parsed >= 0) {
          lastAssignedPage = parsed;
        } else {
          logger.warn({ invalidValue: lastAssignedPageStr }, "Invalid last assigned page value, using 0");
          lastAssignedPage = 0;
        }
      }
      
      // Check if any worker completed and we have more pages
      for (const workerId of activeWorkers) {
        const completeStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId));
        if (completeStr === "1" && lastAssignedPage < totalPages) {
          needsAssignment = true;
          break;
        }
      }
      
      // Also check if no worker has assignment yet
      if (!needsAssignment) {
        for (const workerId of activeWorkers) {
          const pagesStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_PAGES(workerId));
          if (!pagesStr) {
            needsAssignment = true;
            break;
          }
        }
      }
    } else {
      // Even distribution mode: Original logic
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
    }
    
    if (needsAssignment) {
      logger.info({ totalPages, activeWorkers, roundRobin: config.ENABLE_ROUND_ROBIN_ROTATION }, "Assigning/reassigning pages to general workers");
      await distributePagesToGeneralWorkers(totalPages);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, "Error in checkAndAssignWork");
  }
};

const main = async (): Promise<void> => {
  // Check for duplicate manager worker (only one manager should run)
  let ourLockValue: string | undefined;
  try {
    const lockKey = REDIS_KEY_WORKER_LOCK("manager", 1);
    const lockValue = Date.now().toString();
    const LOCK_TTL_SECONDS = 60; // Lock expires after 60 seconds (allows recovery from crashes)
    
    // Atomic operation: SET if Not eXists with EXpiration
    // Returns "OK" if lock was acquired, null if lock already exists
    const result = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
    
    if (result === "OK") {
      // Successfully acquired the lock atomically
      ourLockValue = lockValue; // Store lock value for verification during refresh
    } else {
      // Lock already exists - check if it's stale (from a crashed manager)
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
        
        // Lock is stale (older than 30 seconds) - try to acquire it
        // Use GETSET to atomically get old value and set new value
        const oldValue = await redisConnection.getset(lockKey, lockValue);
        if (oldValue === existingLock) {
          // Successfully acquired stale lock
          ourLockValue = lockValue; // Store lock value for verification during refresh
          await redisConnection.expire(lockKey, LOCK_TTL_SECONDS);
        } else if (oldValue === null) {
          // Lock expired between GET and GETSET - retry with SET NX
          const retryResult = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
          if (retryResult === "OK") {
            // Successfully acquired expired lock
            ourLockValue = lockValue; // Store lock value for verification during refresh
            // Lock acquired - continue startup (skip further retry attempts)
          } else {
            // Another process acquired it during retry - check if it's a real duplicate
            const newLock = await redisConnection.get(lockKey);
            if (newLock) {
              const newLockTime = parseInt(newLock, 10);
              const now = Date.now();
              if (now - newLockTime < 30000) {
                // New lock is recent - real duplicate
                logger.error("❌ Another Manager Worker is already running!");
                logger.error("Please stop the duplicate manager worker");
                process.exit(1);
              }
            }
            // Lock is still stale or doesn't exist - try one more time
            const finalRetry = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
            if (finalRetry !== "OK") {
              logger.error("❌ Another Manager Worker is already running!");
              logger.error("Please stop the duplicate manager worker");
              process.exit(1);
            }
            // Successfully acquired lock on final retry
            ourLockValue = lockValue; // Store lock value for verification during refresh
          }
        } else {
          // oldValue is different from existingLock - lock was modified
          // Could be another process or lock refresh - check if it's recent
          const newLockTime = parseInt(oldValue, 10);
          const now = Date.now();
          if (now - newLockTime < 30000) {
            // New lock is recent - real duplicate
            logger.error("❌ Another Manager Worker is already running!");
            logger.error("Please stop the duplicate manager worker");
            process.exit(1);
          }
          // New lock is also stale - retry with SET NX
          const retryResult = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
          if (retryResult !== "OK") {
            logger.error("❌ Another Manager Worker is already running!");
            logger.error("Please stop the duplicate manager worker");
            process.exit(1);
          }
          ourLockValue = lockValue; // Store lock value for verification during refresh
        }
      } else {
        // Lock doesn't exist (expired between SET NX and GET) - try again
        const retryResult = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
        if (retryResult !== "OK") {
          // Still couldn't acquire - another manager must have started
          logger.error("❌ Another Manager Worker is already running!");
          logger.error("Please stop the duplicate manager worker");
          process.exit(1);
        }
        ourLockValue = lockValue; // Store lock value for verification during refresh
      }
    }
  } catch (error) {
    logger.warn({ error }, "Failed to check for duplicate manager, continuing anyway");
  }
  
  logger.info("🚀 Manager Worker starting...");
  logger.info("Standalone manager - detects active general workers and assigns page ranges to them");
  logger.info({ 
    redisUrl: config.REDIS_URL,
    roundRobinRotation: config.ENABLE_ROUND_ROBIN_ROTATION,
    rotationBatchSize: config.ENABLE_ROUND_ROBIN_ROTATION ? config.ROTATION_BATCH_SIZE : "N/A"
  }, "Manager configuration");
  
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
  const LOCK_TTL_SECONDS = 60; // Lock TTL matches the one used in duplicate check
  
  // If lock value wasn't set (e.g., due to error in duplicate check),
  // try to retrieve it from Redis to ensure lastRefreshTime matches the actual lock timestamp
  if (!ourLockValue) {
    try {
      const lockKey = REDIS_KEY_WORKER_LOCK("manager", 1);
      const lockFromRedis = await redisConnection.get(lockKey);
      if (lockFromRedis) {
        ourLockValue = lockFromRedis;
        logger.info("Retrieved lock value from Redis after duplicate check error");
      } else {
        // Lock doesn't exist in Redis - we can't verify we own it
        // Fail-fast to prevent running without proper duplicate prevention
        logger.error("❌ Cannot verify lock acquisition - lock not found in Redis");
        logger.error("Manager worker cannot proceed without verified lock ownership. Exiting to prevent duplicate managers.");
        process.exit(1);
      }
    } catch (error) {
      // Redis retrieval failed - we can't verify lock ownership
      // Fail-fast to prevent running without proper duplicate prevention
      logger.error({ error }, "❌ Failed to retrieve lock value from Redis");
      logger.error("Manager worker cannot proceed without verified lock ownership. Exiting to prevent duplicate managers.");
      process.exit(1);
    }
  }
  
  // Track last successful refresh time to detect if lock was stolen
  // Use the actual lock value from Redis to ensure it matches what's stored
  let lastRefreshTime = ourLockValue ? parseInt(ourLockValue, 10) : Date.now();
  
  // Refresh lock to prevent expiration while manager is running
  const refreshLock = async (): Promise<void> => {
    try {
      const lockKey = REDIS_KEY_WORKER_LOCK("manager", 1);
      const now = Date.now();
      
      // Get current lock value to verify we still own it
      const currentLock = await redisConnection.get(lockKey);
      
      if (!currentLock) {
        // Lock doesn't exist - we no longer own it (expired or released)
        logger.debug("Lock doesn't exist - not refreshing");
        return;
      }
      
      const currentLockTime = parseInt(currentLock, 10);
      
      // Validate that currentLockTime is a valid number
      // If Redis contains invalid data, parseInt returns NaN, which breaks ownership verification
      if (isNaN(currentLockTime)) {
        logger.warn({ invalidLockValue: currentLock }, "Lock value is not a valid number - not refreshing");
        return;
      }
      
      // Verify ownership: current lock should be close to our last refresh time
      // Since we refresh every 5 seconds (POLL_INTERVAL), the lock value should be
      // within 10-15 seconds of our last refresh. A larger gap indicates another worker acquired it.
      // Use a tight threshold (20 seconds) to detect lock theft quickly
      const LOCK_OWNERSHIP_THRESHOLD_MS = 20000; // 20 seconds - tighter than TTL to catch theft early
      if (Math.abs(currentLockTime - lastRefreshTime) > LOCK_OWNERSHIP_THRESHOLD_MS) {
        logger.warn({ lastRefreshTime, currentLockTime, diff: Math.abs(currentLockTime - lastRefreshTime) }, "Lock appears to be from another worker - not refreshing");
        return;
      }
      
      // We still own the lock - refresh it atomically using GETSET
      const newLockValue = now.toString();
      const oldValue = await redisConnection.getset(lockKey, newLockValue);
      
      // Check if lock expired between GET and GETSET (oldValue is null)
      if (oldValue === null) {
        // Lock expired between GET and GETSET - we no longer own it
        // Another worker may have acquired it or it expired
        logger.warn({ expected: currentLock }, "Lock expired during refresh (GETSET returned null) - lock lost");
        return;
      }
      
      // Verify the old value matches what we expected
      // If oldValue doesn't match currentLock, another worker modified it
      if (oldValue !== currentLock) {
        // Lock was modified by another worker between GET and GETSET - revert our change
        await redisConnection.set(lockKey, oldValue, "EX", LOCK_TTL_SECONDS);
        logger.warn({ expected: currentLock, actual: oldValue }, "Lock was modified by another worker during refresh - reverted");
        return;
      }
      
      // At this point, oldValue === currentLock, so they are identical
      // No need to check timestamp mismatch since they're the same value
      
      // Successfully refreshed - update our tracking
      // Note: GETSET already updated the lock value to newLockValue (now.toString())
      // Now we need to ensure the TTL is refreshed atomically
      // Use SET with EX to update both value and TTL atomically (though GETSET already set the value)
      await redisConnection.set(lockKey, newLockValue, "EX", LOCK_TTL_SECONDS);
      lastRefreshTime = now;
    } catch (error) {
      // Don't log lock refresh errors - they're not critical, but log at debug level
      logger.debug({ error }, "Failed to refresh lock");
    }
  };
  
  const pollForWork = async () => {
    try {
      await checkAndAssignWork();
      // Refresh lock to prevent expiration while manager is running
      await refreshLock();
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
