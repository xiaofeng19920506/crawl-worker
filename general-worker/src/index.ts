import { chromium, Browser, BrowserContext, Page } from "playwright";
import { config, logger, redisConnection, REDIS_KEY_TOTAL_PAGES, REDIS_KEY_TOTAL_PRODUCTS, REDIS_KEY_PRODUCT_URLS, REDIS_KEY_CRAWL_TRIGGER, REDIS_KEY_LAST_PRODUCT_COUNT, REDIS_KEY_TABS_READY, REDIS_KEY_CURRENT_BATCH_START, REDIS_KEY_CURRENT_BATCH_END, REDIS_KEY_BATCH_COMPLETE, REDIS_KEY_GENERAL_WORKER_COMPLETE, REDIS_KEY_WORKER_PAGES, REDIS_KEY_WORKER_COMPLETE, REDIS_KEY_WORKER_HEARTBEAT, REDIS_KEY_PENDING_PAGES, REDIS_KEY_ASSIGNED_PAGES, REDIS_KEY_GENERAL_WORKER_HEARTBEAT, REDIS_KEY_GENERAL_WORKER_PAGES, REDIS_KEY_GENERAL_WORKER_PROCESSING, REDIS_KEY_AMAZON_COOKIES, REDIS_KEY_AMAZON_SESSION_VALID, REDIS_KEY_WORKER_LOCK, productsQueue, ProductJobData } from "shared";
import { setTimeout as delay } from "node:timers/promises";

let browser: Browser | null = null;
let context: BrowserContext | null = null;

const getBrowser = async (): Promise<Browser> => {
  if (browser && browser.isConnected()) {
    return browser;
  }

  // Try to connect to existing Chrome browser via CDP first
  if (config.PLAYWRIGHT_CDP_ENDPOINT) {
    try {
      logger.info({ endpoint: config.PLAYWRIGHT_CDP_ENDPOINT }, "Attempting to connect to existing Chrome via CDP");
      
      // Fetch WebSocket URL from Chrome's JSON endpoint with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${config.PLAYWRIGHT_CDP_ENDPOINT}/json/version`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch Chrome version: ${response.status} ${response.statusText}`);
      }
      
      const chromeInfo = await response.json();
      const wsEndpoint = chromeInfo.webSocketDebuggerUrl;
      
      if (!wsEndpoint) {
        throw new Error("No WebSocket debugger URL found in Chrome response");
      }
      
      logger.info({ wsEndpoint }, "Connecting to existing Chrome via CDP");
      browser = await chromium.connectOverCDP(wsEndpoint);
      
      if (browser && browser.isConnected()) {
        logger.info("Successfully connected to existing Chrome browser");
        return browser;
      } else {
        throw new Error("Browser connected but isConnected() returned false");
      }
    } catch (error: any) {
      // Extract error message more thoroughly
      let errorMsg = "Unknown error";
      let errorDetails: any = {};
      
      if (error instanceof Error) {
        errorMsg = error.message;
        errorDetails = {
          name: error.name,
          stack: error.stack,
        };
      } else if (typeof error === "string") {
        errorMsg = error;
      } else if (error && typeof error === "object") {
        errorMsg = error.message || error.toString() || JSON.stringify(error);
        errorDetails = error;
      }
      
      logger.error({ 
        error: errorMsg,
        errorDetails,
        endpoint: config.PLAYWRIGHT_CDP_ENDPOINT,
      }, "Failed to connect via CDP, will launch new browser");
      
      // If it's a network error, provide helpful message
      if (errorMsg.includes("fetch") || errorMsg.includes("ECONNREFUSED") || errorMsg.includes("timeout") || errorMsg.includes("aborted") || errorMsg.includes("network") || errorMsg.includes("Failed to fetch")) {
        logger.error("Chrome remote debugging is not accessible. Make sure Chrome is started with --remote-debugging-port=9222");
        logger.error("You can verify by opening: http://localhost:9222/json/version in your browser");
      }
    }
  } else {
    logger.info("PLAYWRIGHT_CDP_ENDPOINT not configured, will launch new browser");
  }

  // Fall back to launching a new browser with persistent context
  const userDataDir = config.PLAYWRIGHT_USER_DATA_DIR || "./browser-data";
  const chromePath = config.PLAYWRIGHT_CHROME_EXECUTABLE_PATH;
  
  logger.info({ 
    userDataDir, 
    headless: config.PLAYWRIGHT_HEADLESS,
    chromePath: chromePath || "default (Playwright bundled)",
  }, "Launching new browser with persistent context");
  
  const launchOptions: any = {
    headless: config.PLAYWRIGHT_HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
    viewport: { width: 1920, height: 1080 },
  };
  
  // Only add executablePath if provided (for local Chrome)
  if (chromePath) {
    launchOptions.executablePath = chromePath;
  }
  
  // Only add sandbox args on Linux
  if (process.platform === "linux") {
    launchOptions.args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
  }
  
  context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  browser = context.browser();
  if (!browser) {
    throw new Error("Failed to get browser from persistent context");
  }
  
  // Load shared cookies immediately after creating context (for different servers)
  await loadSharedCookies(context).catch(() => {
    logger.debug("No shared cookies available yet, will load on first login");
  });
  
  logger.info("Successfully launched new browser");
  return browser;
};

const getPage = async (): Promise<Page> => {
  const browserInstance = await getBrowser();
  
  // Helper function to filter out DevTools pages
  const isRegularPage = (page: Page): boolean => {
    try {
      const url = page.url();
      // Filter out DevTools pages and other internal Chrome pages
      return !url.startsWith("devtools://") && 
             !url.startsWith("chrome://") && 
             !url.startsWith("chrome-extension://") &&
             !url.startsWith("about:");
    } catch {
      // If we can't get the URL, assume it's a regular page (might be closed)
      return true;
    }
  };
  
  // If we have a context (from persistent launch), use it
  if (context) {
    // Try to load shared cookies if available
    await loadSharedCookies(context).catch(() => {});
    
    const pages = context.pages();
    // Filter out DevTools pages
    const regularPages = pages.filter(isRegularPage);
    if (regularPages.length > 0) {
      logger.info({ url: regularPages[0].url() }, "Using existing regular page from context");
      return regularPages[0];
    }
    logger.info("No regular pages found in context, creating new page");
    return await context.newPage();
  }
  
  // For CDP connections, get or create a context
  const contexts = browserInstance.contexts();
  if (contexts.length > 0) {
    // Use the first existing context
    const existingContext = contexts[0];
    
    // Try to load shared cookies if available
    await loadSharedCookies(existingContext).catch(() => {});
    
    const pages = existingContext.pages();
    // Filter out DevTools pages
    const regularPages = pages.filter(isRegularPage);
    if (regularPages.length > 0) {
      logger.info({ url: regularPages[0].url() }, "Using existing regular page from CDP context");
      return regularPages[0];
    }
    logger.info("No regular pages found in CDP context, creating new page");
    return await existingContext.newPage();
  }
  
  // Create a new context if none exists
  logger.info("No contexts found, creating new context and page");
  const newContext = await browserInstance.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  
  // Try to load shared cookies if available
  await loadSharedCookies(newContext).catch(() => {});
  
  return await newContext.newPage();
};

const loadSharedCookies = async (targetContext: BrowserContext): Promise<boolean> => {
  try {
    const cookiesStr = await redisConnection.get(REDIS_KEY_AMAZON_COOKIES);
    if (!cookiesStr) {
      logger.debug("No shared cookies found in Redis");
      return false;
    }
    
    const cookies = JSON.parse(cookiesStr);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      logger.debug("Invalid or empty cookies in Redis");
      return false;
    }
    
    // Check if session is still valid
    const sessionValid = await redisConnection.get(REDIS_KEY_AMAZON_SESSION_VALID);
    if (sessionValid !== "1") {
      logger.debug("Session marked as invalid, not loading cookies");
      return false;
    }
    
    // Add cookies to context
    await targetContext.addCookies(cookies);
    logger.info({ cookieCount: cookies.length }, "✅ Loaded shared cookies from Redis");
    return true;
  } catch (error) {
    logger.warn({ error }, "Failed to load shared cookies, will login normally");
    return false;
  }
};

const saveSharedCookies = async (targetContext: BrowserContext): Promise<void> => {
  try {
    const cookies = await targetContext.cookies();
    if (cookies.length > 0) {
      await redisConnection.set(REDIS_KEY_AMAZON_COOKIES, JSON.stringify(cookies));
      await redisConnection.set(REDIS_KEY_AMAZON_SESSION_VALID, "1");
      logger.info({ cookieCount: cookies.length }, "✅ Saved cookies to Redis for sharing");
    }
  } catch (error) {
    logger.warn({ error }, "Failed to save cookies to Redis");
  }
};

const isSignedIn = async (page: Page): Promise<boolean> => {
  try {
    const accountGreeting = await page
      .locator("#nav-link-accountList-nav-line-1")
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => null);

    if (accountGreeting) {
      const greeting = accountGreeting.toLowerCase();
      if (greeting.includes("hello") || greeting.includes("hi") || greeting.includes("account")) {
        return true;
      }
      if (!greeting.includes("sign in") && greeting.length > 0) {
        return true;
      }
    }

    const signInButton = page.locator("#nav-signin-tooltip");
    const signInVisible = await signInButton.isVisible({ timeout: 3000 }).catch(() => false);
    if (!signInVisible) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
};

const ensureLoggedIn = async (page: Page): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  
  // Try to load shared cookies first (if available)
  const context = page.context();
  const cookiesLoaded = await loadSharedCookies(context);
  
  if (cookiesLoaded) {
    // Try navigating with shared cookies
    logger.info({ workerId }, "Using shared cookies, checking if session is valid...");
    await navigateToEncoreQueue(page);
    await delay(3000);
    
    const signedIn = await isSignedIn(page);
    if (signedIn) {
      logger.info({ workerId }, "✅ Logged in successfully using shared cookies");
      return; // Success with shared cookies
    } else {
      logger.warn({ workerId }, "Shared cookies invalid, will login normally");
      await redisConnection.set(REDIS_KEY_AMAZON_SESSION_VALID, "0"); // Mark session as invalid
    }
  }
  
  // Navigate directly to encore queue to check login status
  await navigateToEncoreQueue(page);

  await delay(3000);

  const signedIn = await isSignedIn(page);
  if (!signedIn) {
    logger.error({ currentUrl: page.url(), workerId }, "Not logged in. Please log in manually or wait for another worker to login.");
    throw new Error("Not logged in. Please log in manually or wait for session to be shared.");
  }

  logger.info({ workerId }, "✅ Logged in successfully");
  
  // Save cookies to Redis for other workers to use
  await saveSharedCookies(context);
};

const discoverPageInfo = async (page: Page): Promise<{ totalPages: number; totalProducts: number }> => {
  logger.info("Discovering total pages and products from encore page...");

  // Ensure we're on the encore queue page
  const currentUrl = page.url();
  if (!currentUrl.includes("queue=encore")) {
    logger.info("Navigating to encore queue...");
    await navigateToEncoreQueue(page);
  }
  
  // Wait for page to fully load
  await delay(5000);
  
  logger.info({ url: page.url() }, "Current page URL");

  // Extract information from the page using JavaScript evaluation
  const pageInfo = await page.evaluate(() => {
    const result: { totalPages: number; totalProducts: number } = {
      totalPages: 1,
      totalProducts: 0,
    };

    // Method 1: Find pagination component and extract last page number
    const paginationSelectors = [
      'span[data-component-type="s-pagination"]',
      '.s-pagination',
      '[aria-label*="pagination"]',
      '.a-pagination',
    ];

    for (const selector of paginationSelectors) {
      const pagination = document.querySelector(selector);
      if (pagination) {
        // Find all page number links/buttons
        const pageLinks = pagination.querySelectorAll('a[aria-label*="page"], button[aria-label*="page"], a[href*="page="], span');
        const pageNumbers: number[] = [];
        
        pageLinks.forEach((element) => {
          const text = element.textContent?.trim() || '';
          const ariaLabel = element.getAttribute('aria-label') || '';
          const href = element.getAttribute('href') || '';
          
          // Extract numbers from text (handle commas in numbers like "1,234")
          const textMatch = text.match(/[\d,]+/);
          if (textMatch) {
            const num = parseInt(textMatch[0].replace(/,/g, ''), 10);
            if (num > 0 && num < 100000) {
              pageNumbers.push(num);
            }
          }
          
          // Extract from aria-label
          const ariaMatch = ariaLabel.match(/page\s+(\d+)/i) || ariaLabel.match(/(\d+)/);
          if (ariaMatch) {
            const num = parseInt(ariaMatch[1], 10);
            if (num > 0 && num < 100000) {
              pageNumbers.push(num);
            }
          }
          
          // Extract from href
          const hrefMatch = href.match(/[?&]page=(\d+)/);
          if (hrefMatch) {
            const num = parseInt(hrefMatch[1], 10);
            if (num > 0 && num < 100000) {
              pageNumbers.push(num);
            }
          }
        });
        
        if (pageNumbers.length > 0) {
          result.totalPages = Math.max(...pageNumbers);
          console.log('Found total pages from pagination:', result.totalPages, 'from numbers:', pageNumbers);
          break;
        }
      }
    }

    // Method 2: Find total products count from text like "Displaying X-Y of Z results"
    // Amazon Vine shows: "Displaying 1-36 of X results" (where X is the total count)
    const resultTextSelectors = [
      'span',
      'div',
      'p',
      '[class*="result"]',
      '[class*="displaying"]',
    ];

    for (const selector of resultTextSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of Array.from(elements)) {
        const text = element.textContent || '';
        
        // Primary pattern: "Displaying X-Y of Z results" (with commas in numbers)
        const displayingMatch = text.match(/displaying\s+[\d,]+\s*-\s*[\d,]+\s+of\s+([\d,]+)\s+results/i);
        if (displayingMatch) {
          const total = parseInt(displayingMatch[1].replace(/,/g, ''), 10);
          if (total > 0) {
            result.totalProducts = total;
            console.log('Found total products from "Displaying" text:', result.totalProducts, 'from text:', text);
            break;
          }
        }
        
        // Secondary patterns: "Showing X-Y of Z items" or "X-Y of Z"
        const showingMatch = text.match(/showing\s+[\d,]+\s*-\s*[\d,]+\s+of\s+([\d,]+)/i) || 
                            text.match(/[\d,]+\s*-\s*[\d,]+\s+of\s+([\d,]+)/i) ||
                            text.match(/of\s+([\d,]+)\s+items/i) ||
                            text.match(/of\s+([\d,]+)\s+results/i);
        
        if (showingMatch) {
          const total = parseInt(showingMatch[1].replace(/,/g, ''), 10);
          if (total > 0 && total > result.totalProducts) {
            result.totalProducts = total;
            console.log('Found total products from text:', result.totalProducts, 'from text:', text);
          }
        }
      }
      
      if (result.totalProducts > 0) {
        break;
      }
    }

    // Method 3: Count products on the current page and estimate
    // This is a fallback if we can't find the total count
    if (result.totalProducts === 0) {
      const productElements = document.querySelectorAll('[data-asin], [data-recommendation-id], [data-item-index]');
      if (productElements.length > 0) {
        // Estimate: if we see products, at least we have this many
        result.totalProducts = productElements.length;
        console.log('Estimated products from visible items:', result.totalProducts);
      }
    }

    return result;
  });

  logger.info({ pageInfo }, "Extracted page information");

  // If we couldn't find total pages from pagination, try to find it by looking at the last page link
  if (pageInfo.totalPages === 1) {
    logger.info("Total pages not found in pagination, trying alternative methods...");
    
    // Try to find the last page number in pagination
    const lastPageSelectors = [
      'a[aria-label*="last"]',
      'a[aria-label*="Go to page"]:last-of-type',
      '.s-pagination a:last-of-type',
      'span[data-component-type="s-pagination"] a:last-of-type',
    ];

    for (const selector of lastPageSelectors) {
      try {
        const lastPageElement = await page.locator(selector).first();
        if (await lastPageElement.isVisible({ timeout: 3000 }).catch(() => false)) {
          const text = await lastPageElement.textContent();
          const ariaLabel = await lastPageElement.getAttribute('aria-label');
          const href = await lastPageElement.getAttribute('href');
          
          const matches = [
            text?.match(/\d+/),
            ariaLabel?.match(/(\d+)/),
            href?.match(/[?&]page=(\d+)/),
          ].filter(Boolean) as RegExpMatchArray[];
          
          if (matches.length > 0) {
            const pageNum = parseInt(matches[0][1] || matches[0][0], 10);
            if (pageNum > pageInfo.totalPages) {
              pageInfo.totalPages = pageNum;
              logger.info({ totalPages: pageInfo.totalPages }, "Found total pages from last page link");
              break;
            }
          }
        }
      } catch (error) {
        // Continue to next selector
      }
    }
  }

  // Calculate total pages from total products if we have product count but not page count
  // This is a fallback - we should normally get totalPages from pagination
  if (pageInfo.totalProducts > 0 && pageInfo.totalPages === 1) {
    logger.warn("Could not extract total pages from pagination, attempting to calculate from product count");
    
    // Try to determine items per page from the current page
    const itemsPerPage = await page.evaluate(() => {
      // Count visible products on current page
      const productElements = document.querySelectorAll('[data-asin], [data-recommendation-id], [data-item-index]');
      return productElements.length || 24; // Default to 24 if can't count
    });
    
    if (itemsPerPage > 0) {
      pageInfo.totalPages = Math.ceil(pageInfo.totalProducts / itemsPerPage);
      logger.warn({ 
        totalPages: pageInfo.totalPages, 
        totalProducts: pageInfo.totalProducts,
        itemsPerPage,
        note: "Calculated from product count - pagination extraction may have failed"
      }, "Calculated total pages from product count (fallback method)");
    } else {
      logger.error("Could not determine items per page for calculation");
    }
  }

  // If we still don't have the info, log page content for debugging
  if (pageInfo.totalPages === 1 || pageInfo.totalProducts === 0) {
    logger.warn("Could not extract all page info, capturing page content for debugging...");
    const pageContent = await page.evaluate(() => {
      // Get all text that might contain the info
      const allText = Array.from(document.querySelectorAll('span, div, p')).map(el => el.textContent?.trim()).filter(Boolean);
      const relevantText = allText.filter(text => 
        text.includes('Displaying') || 
        text.includes('Showing') || 
        text.includes('of') || 
        text.includes('results') || 
        text.includes('items') ||
        text.match(/\d+.*of.*\d+/)
      );
      
      return {
        title: document.title,
        url: window.location.href,
        paginationHTML: document.querySelector('span[data-component-type="s-pagination"], .s-pagination, .a-pagination')?.outerHTML || 'Not found',
        paginationText: document.querySelector('span[data-component-type="s-pagination"], .s-pagination, .a-pagination')?.textContent || 'Not found',
        relevantText: relevantText.slice(0, 20),
      };
    });
    logger.warn({ pageContent }, "Page content for debugging");
  }

  return pageInfo;
};

const checkFor503Error = async (page: Page): Promise<boolean> => {
  try {
    // Only check for 503 on the specific endpoint: https://www.amazon.com/vine
    const url = page.url();
    const vineBaseUrl = config.AMAZON_VINE_BASE_URL || "https://www.amazon.com/vine";
    
    // Check if URL matches the exact endpoint (with or without trailing slash, with or without query params)
    const urlMatches = url.startsWith(vineBaseUrl) || url.startsWith(vineBaseUrl + "/");
    if (!urlMatches) {
      return false; // Not on the vine endpoint, ignore 503 errors
    }
    
    // Check page title - must be exactly an error page title
    const title = await page.title().catch(() => "");
    const titleLower = title.toLowerCase();
    if (titleLower.includes("503") && (titleLower.includes("error") || titleLower.includes("unavailable") || titleLower.includes("service unavailable"))) {
      return true;
    }
    
    // Check for specific 503 error page elements - be very strict
    const has503Error = await page.evaluate(() => {
      // Check for Amazon's specific error page structure
      const bodyText = document.body?.textContent || "";
      const h1Text = document.querySelector("h1")?.textContent || "";
      const h1Lower = h1Text.toLowerCase();
      
      // Very specific error patterns - must match exactly
      const isExactErrorPage = 
        // H1 must contain both "503" AND "service unavailable" (or similar)
        (h1Lower.includes("503") && (h1Lower.includes("service unavailable") || h1Lower.includes("error"))) ||
        // Body must contain the exact error phrase
        /503\s+service\s+unavailable/i.test(bodyText) ||
        // Amazon-specific error indicators
        (bodyText.includes("We're sorry") && bodyText.includes("503")) ||
        (bodyText.includes("temporarily unavailable") && bodyText.includes("503"));
      
      // Don't check minimal content - pages might still be loading
      // Only return true if we have a clear error page match
      return isExactErrorPage;
    }).catch(() => false);
    
    return has503Error;
  } catch {
    return false;
  }
};

const navigateToEncoreQueue = async (page: Page, retryCount = 0): Promise<void> => {
  const currentUrl = page.url();

  if (currentUrl.includes("queue=encore")) {
    // Check if current page has 503 error (only on https://www.amazon.com/vine endpoint)
    const has503 = await checkFor503Error(page);
    if (has503) {
      logger.warn({ url: page.url() }, "503 error detected on https://www.amazon.com/vine endpoint, waiting 5 minutes before retry...");
      await delay(300000); // Wait 5 minutes (300000ms)
      // Force reload
      await page.reload({ waitUntil: "load", timeout: 60000 });
      return navigateToEncoreQueue(page, retryCount + 1);
    }
    return;
  }

  if (currentUrl.includes("/ap/signin") || currentUrl.includes("/signin")) {
    throw new Error("Session expired - redirected to sign-in page");
  }

  try {
    const response = await page.goto(config.AMAZON_VINE_ENCORE_URL, {
      waitUntil: "load",
      timeout: 60000,
    });
    
    // Check for 503 status - only on https://www.amazon.com/vine endpoint
    const responseUrl = response?.url() || "";
    const vineBaseUrl = config.AMAZON_VINE_BASE_URL || "https://www.amazon.com/vine";
    const isVineEndpoint = responseUrl.startsWith(vineBaseUrl) || responseUrl.startsWith(vineBaseUrl + "/");
    
    if (response && response.status() === 503 && isVineEndpoint) {
      logger.warn({ status: response.status(), url: response.url() }, "503 Service Unavailable detected on https://www.amazon.com/vine endpoint, waiting 5 minutes before retry...");
      await delay(300000); // Wait 5 minutes (300000ms)
      return navigateToEncoreQueue(page, retryCount + 1);
    }
    
    await delay(2000);
    
    // Check page content for 503 error (only on https://www.amazon.com/vine endpoint)
    const has503 = await checkFor503Error(page);
    if (has503) {
      logger.warn({ url: page.url() }, "503 error detected in page content on https://www.amazon.com/vine endpoint, waiting 5 minutes before retry...");
      await delay(300000); // Wait 5 minutes (300000ms)
      return navigateToEncoreQueue(page, retryCount + 1);
    }

    const newUrl = page.url();
    if (newUrl.includes("/ap/signin") || newUrl.includes("/signin")) {
      throw new Error("Session expired after navigation");
    }
  } catch (error: any) {
    // Check if error is related to 503 - only retry if we're navigating to the vine endpoint
    const targetUrl = config.AMAZON_VINE_ENCORE_URL || config.AMAZON_VINE_BASE_URL || "";
    const isVineEndpoint = targetUrl.includes("/vine");
    
    if (isVineEndpoint && (error?.message?.includes("503") || error?.message?.includes("Service Unavailable"))) {
      logger.warn({ error: error.message, url: targetUrl }, "503 error during navigation to https://www.amazon.com/vine endpoint");
      
      logger.warn("Waiting 5 minutes before retry...");
      await delay(300000); // Wait 5 minutes (300000ms)
      return navigateToEncoreQueue(page, retryCount + 1);
    }
    throw error;
  }
};


const openBatchOfTabs = async (targetContext: BrowserContext, batchStart: number, batchEnd: number, totalPages: number, tabsOpenedSoFar: number): Promise<number> => {
  logger.info({ batchStart, batchEnd, totalPages }, "Opening batch of page tabs");
  
  // Open all tabs in parallel - wait for tabs to be created (but not for navigation to complete)
  const startTime = Date.now();
  const tabPromises: Promise<void>[] = [];
  
  for (let pageNum = batchStart; pageNum <= batchEnd; pageNum++) {
    const tabPromise = (async () => {
      try {
        const encoreUrl = `${config.AMAZON_VINE_ENCORE_URL}&page=${pageNum}`;
        const tab = await targetContext.newPage();
        
        // Navigate with minimal wait - just commit, don't wait for full load
        tab.goto(encoreUrl, { 
          waitUntil: "commit", // Fastest option - just wait for navigation to commit
          timeout: 30000 
        }).catch(() => {
          // Navigation continues in background - non-blocking
        });
      } catch (error: any) {
        // Log error but continue
        logger.warn({ error: error.message, pageNum }, "Failed to open tab");
      }
    })();
    
    tabPromises.push(tabPromise);
  }
  
  // Wait for all tabs to be created (but navigation continues in background)
  await Promise.all(tabPromises);
  
  const elapsed = Date.now() - startTime;
  const batchSize = batchEnd - batchStart + 1;
  logger.info({ elapsed, batchSize, tabsCreated: batchSize }, "✅ All tabs created in batch");
  
  return batchSize;
};

const closeBatchTabs = async (targetContext: BrowserContext, batchStart: number, batchEnd: number): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  logger.info({ workerId, batchStart, batchEnd }, "Closing tabs for completed batch");
  
  try {
    const pages = targetContext.pages();
    let closedCount = 0;
    let skippedCount = 0;
    const pagesToClose: Page[] = [];
    
    // First, collect all pages that match the batch range
    for (const page of pages) {
      try {
        if (page.isClosed()) {
          skippedCount++;
          continue;
        }
        
        const url = page.url();
        // Check if this page URL matches the batch range
        const pageMatch = url.match(/[?&]page=(\d+)/);
        if (pageMatch) {
          const pageNum = parseInt(pageMatch[1], 10);
          if (pageNum >= batchStart && pageNum <= batchEnd) {
            pagesToClose.push(page);
          }
        }
      } catch (error: any) {
        // Page might be closed or inaccessible - skip it
        skippedCount++;
        logger.debug({ error: error.message }, "Skipping page (may be closed or inaccessible)");
      }
    }
    
    // Close all matching pages in parallel for efficiency
    const closePromises = pagesToClose.map(async (page) => {
      try {
        if (!page.isClosed()) {
          await page.close();
          return true;
        }
        return false;
      } catch (error: any) {
        logger.debug({ error: error.message }, "Error closing individual tab");
        return false;
      }
    });
    
    const results = await Promise.all(closePromises);
    closedCount = results.filter(r => r === true).length;
    
    logger.info({ 
      workerId, 
      batchStart, 
      batchEnd, 
      closedCount, 
      skippedCount,
      totalPagesInContext: pages.length 
    }, "✅ Closed tabs for batch");
    
    // Verify tabs are actually closed (double-check)
    await delay(500); // Small delay to let closing complete
    const remainingPages = targetContext.pages().filter(p => {
      try {
        if (p.isClosed()) return false;
        const url = p.url();
        const pageMatch = url.match(/[?&]page=(\d+)/);
        if (pageMatch) {
          const pageNum = parseInt(pageMatch[1], 10);
          return pageNum >= batchStart && pageNum <= batchEnd;
        }
        return false;
      } catch {
        return false;
      }
    });
    
    if (remainingPages.length > 0) {
      logger.warn({ workerId, batchStart, batchEnd, remainingCount: remainingPages.length }, "Some tabs from this batch are still open - retrying close");
      // Retry closing remaining tabs
      for (const page of remainingPages) {
        try {
          if (!page.isClosed()) {
            await page.close();
          }
        } catch {
          // Ignore errors on retry
        }
      }
    }
  } catch (error) {
    logger.error({ error, workerId, batchStart, batchEnd }, "Error closing batch tabs");
    // Don't throw - continue to next batch even if closing fails
  }
};

const detectActiveWorkers = async (): Promise<number[]> => {
  // Check for active workers by looking for heartbeats
  // A worker is considered active if it has a heartbeat within the last 60 seconds
  const HEARTBEAT_TIMEOUT_MS = 60000; // 60 seconds
  const now = Date.now();
  const activeWorkers: number[] = [];
  
  // Check workers 1-20 (reasonable max)
  for (let workerId = 1; workerId <= 20; workerId++) {
    const heartbeatStr = await redisConnection.get(REDIS_KEY_WORKER_HEARTBEAT(workerId));
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

const distributePagesToWorkers = async (pages: number[]): Promise<void> => {
  // Detect active workers automatically
  const activeWorkers = await detectActiveWorkers();
  
  if (activeWorkers.length === 0) {
    logger.warn("No active workers detected! Using fallback worker count from config.");
    const fallbackWorkers = config.PRODUCT_WORKER_TOTAL || 1;
    const fallbackActiveWorkers = Array.from({ length: fallbackWorkers }, (_, i) => i + 1);
    return distributePagesToWorkersWithList(pages, fallbackActiveWorkers);
  }
  
  logger.info({ activeWorkers, count: activeWorkers.length }, "Detected active workers");
  return distributePagesToWorkersWithList(pages, activeWorkers);
};

const distributePagesToWorkersWithList = async (pages: number[], activeWorkers: number[]): Promise<void> => {
  const totalWorkers = activeWorkers.length;
  
  // Distribute pages evenly among active workers using round-robin
  const workerPages: number[][] = Array.from({ length: totalWorkers }, () => []);
  
  pages.forEach((page, index) => {
    const workerIndex = index % totalWorkers;
    workerPages[workerIndex].push(page);
  });
  
  // Assign pages to each active worker in Redis
  for (let i = 0; i < activeWorkers.length; i++) {
    const workerId = activeWorkers[i];
    const pagesForWorker = workerPages[i];
    await redisConnection.set(REDIS_KEY_WORKER_PAGES(workerId), JSON.stringify(pagesForWorker));
    logger.info({ workerId, pagesCount: pagesForWorker.length, pages: pagesForWorker.slice(0, 5) }, "Assigned pages to worker");
  }
  
  // Clear pages for any inactive workers (workers not in activeWorkers list)
  // Check workers 1-20 and clear any that aren't active
  for (let workerId = 1; workerId <= 20; workerId++) {
    if (!activeWorkers.includes(workerId)) {
      await redisConnection.del(REDIS_KEY_WORKER_PAGES(workerId));
    }
  }
  
  // Store pending pages for dynamic reassignment
  await redisConnection.set(REDIS_KEY_PENDING_PAGES, JSON.stringify([]));
  await redisConnection.set(REDIS_KEY_ASSIGNED_PAGES, JSON.stringify(pages));
  
  logger.info({ totalPages: pages.length, activeWorkers, totalWorkers }, "✅ Pages distributed to active workers");
};

const reassignPagesFromIdleWorkers = async (activeWorkers: number[]): Promise<void> => {
  // Check for idle workers and reassign their pages to busy workers
  const busyWorkers: number[] = [];
  const idleWorkers: number[] = [];
  
  for (const workerId of activeWorkers) {
    const pagesStr = await redisConnection.get(REDIS_KEY_WORKER_PAGES(workerId));
    if (pagesStr) {
      const pages = JSON.parse(pagesStr) as number[];
      if (pages.length > 0) {
        busyWorkers.push(workerId);
      } else {
        idleWorkers.push(workerId);
      }
    } else {
      idleWorkers.push(workerId);
    }
  }
  
  // If we have idle workers and busy workers, redistribute
  if (idleWorkers.length > 0 && busyWorkers.length > 0) {
    // Get pages from the busiest worker and give to idle workers
    const busiestWorkerId = busyWorkers[0];
    const pagesStr = await redisConnection.get(REDIS_KEY_WORKER_PAGES(busiestWorkerId));
    if (pagesStr) {
      const pages = JSON.parse(pagesStr) as number[];
      if (pages.length > 1) {
        // Take half of pages from busiest worker
        const half = Math.ceil(pages.length / 2);
        const reassignPages = pages.splice(half);
        const keepPages = pages;
        
        // Update busiest worker
        await redisConnection.set(REDIS_KEY_WORKER_PAGES(busiestWorkerId), JSON.stringify(keepPages));
        
        // Give pages to idle workers
        const pagesPerIdleWorker = Math.ceil(reassignPages.length / idleWorkers.length);
        for (let i = 0; i < idleWorkers.length; i++) {
          const start = i * pagesPerIdleWorker;
          const end = Math.min(start + pagesPerIdleWorker, reassignPages.length);
          const pagesForWorker = reassignPages.slice(start, end);
          
          if (pagesForWorker.length > 0) {
            await redisConnection.set(REDIS_KEY_WORKER_PAGES(idleWorkers[i]), JSON.stringify(pagesForWorker));
            logger.info({ fromWorker: busiestWorkerId, toWorker: idleWorkers[i], pagesCount: pagesForWorker.length }, "Reassigned pages from busy to idle worker");
          }
        }
      }
    }
  }
};

const waitForBatchCompletion = async (): Promise<void> => {
  logger.info("Waiting for product workers to complete current batch...");
  
  // Poll every 2 seconds to check if batch is complete and reassign work if needed
  while (true) {
    // Detect active workers dynamically
    const activeWorkers = await detectActiveWorkers();
    
    if (activeWorkers.length === 0) {
      logger.warn("No active workers detected during batch completion check");
      await delay(2000);
      continue;
    }
    
    // Check if all active workers are done
    let allComplete = true;
    for (const workerId of activeWorkers) {
      const pagesStr = await redisConnection.get(REDIS_KEY_WORKER_PAGES(workerId));
      if (pagesStr) {
        const pages = JSON.parse(pagesStr) as number[];
        if (pages.length > 0) {
          allComplete = false;
          break;
        }
      }
    }
    
    if (allComplete) {
      logger.info({ activeWorkers }, "All active workers completed their assigned pages - batch complete");
      await redisConnection.set(REDIS_KEY_BATCH_COMPLETE, "1");
      break;
    }
    
    // Try to reassign pages from busy workers to idle workers
    await reassignPagesFromIdleWorkers(activeWorkers);
    
    await delay(2000); // Wait 2 seconds before checking again
  }
};

const openAllPageTabsInBatches = async (page: Page, assignedStartPage: number, assignedEndPage: number): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  try {
    logger.info({ workerId, assignedStartPage, assignedEndPage, totalPages: assignedEndPage - assignedStartPage + 1 }, "Starting to open assigned page tabs in batches");
    
    // Get browser context
    const browserInstance = await getBrowser();
    let targetContext: BrowserContext;
    
    if (context) {
      targetContext = context;
    } else {
      const contexts = browserInstance.contexts();
      if (contexts.length > 0) {
        targetContext = contexts[0];
      } else {
        throw new Error("No browser context available");
      }
    }
    
    const TABS_PER_BATCH = config.TABS_PER_BATCH || 50;
    let totalTabsOpened = 0;
    
    // Process assigned pages in batches
    for (let batchStart = assignedStartPage; batchStart <= assignedEndPage; batchStart += TABS_PER_BATCH) {
      const batchEnd = Math.min(batchStart + TABS_PER_BATCH - 1, assignedEndPage);
      
      // Set current batch info in Redis
      await redisConnection.set(REDIS_KEY_CURRENT_BATCH_START, batchStart.toString());
      await redisConnection.set(REDIS_KEY_CURRENT_BATCH_END, batchEnd.toString());
      await redisConnection.del(REDIS_KEY_BATCH_COMPLETE); // Clear completion flag
      await redisConnection.del(REDIS_KEY_TABS_READY); // Clear ready flag
      
      logger.info({ workerId, batchStart, batchEnd, assignedStartPage, assignedEndPage, batchNumber: Math.ceil((batchStart - assignedStartPage) / TABS_PER_BATCH) + 1, tabsPerBatch: TABS_PER_BATCH }, "Starting new batch");
      
      // Open this batch of tabs
      const tabsOpened = await openBatchOfTabs(targetContext, batchStart, batchEnd, assignedEndPage, totalTabsOpened);
      totalTabsOpened += tabsOpened;
      
      logger.info({ workerId, batchStart, batchEnd, tabsOpened, totalTabsOpened }, "✅ Batch of tabs opened");
      
      // Distribute pages among all active product workers BEFORE triggering them
      const pages = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);
      await distributePagesToWorkers(pages);
      
      // Mark tabs as ready and trigger product workers
      await redisConnection.set(REDIS_KEY_TABS_READY, "1");
      await redisConnection.set(REDIS_KEY_CRAWL_TRIGGER, "1");
      logger.info({ workerId, batchStart, batchEnd }, "✅ Tabs ready - assigned pages and triggered product workers to crawl this batch");
      
      // Wait for product workers to complete this batch before opening next
      await waitForBatchCompletion();
      
      logger.info({ workerId, batchStart, batchEnd }, "✅ Batch processing complete - all products crawled");
      
      // Close tabs for this completed batch BEFORE opening next batch
      await closeBatchTabs(targetContext, batchStart, batchEnd);
      
      logger.info({ workerId, batchStart, batchEnd }, "✅ Batch tabs closed, ready for next batch");
      
      // Small delay to ensure tabs are fully closed before opening next batch
      await delay(1000);
    }
    
    logger.info({ workerId, totalTabs: totalTabsOpened, totalPages: assignedEndPage - assignedStartPage + 1 }, "✅ All batches processed - all assigned page tabs opened and crawled");
    
    // Mark this general worker as complete
    await redisConnection.set(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId), "1");
    logger.info({ workerId }, "✅ General worker completed assigned page range");
  } catch (error) {
    const currentWorkerId = config.GENERAL_WORKER_ID || 1;
    logger.error({ error, workerId: currentWorkerId }, "Failed to open page tabs in batches");
    throw error;
  }
};


const crawlAndCheck = async (page: Page): Promise<void> => {
  try {
    // Discover total pages and products from the encore page
    logger.info("Starting page and product info discovery from encore page...");
    const { totalPages, totalProducts: discoveredTotalProducts } = await discoverPageInfo(page);
    
    // Get previous values from Redis
    const previousTotalPages = await redisConnection.get(REDIS_KEY_TOTAL_PAGES);
    const previousTotalProducts = await redisConnection.get(REDIS_KEY_TOTAL_PRODUCTS);
    const lastProductCount = await redisConnection.get(REDIS_KEY_LAST_PRODUCT_COUNT);
    
    // Check if values have changed
    const pagesChanged = previousTotalPages !== totalPages.toString();
    const productsChanged = previousTotalProducts !== discoveredTotalProducts.toString();
    const productCountChanged = lastProductCount !== discoveredTotalProducts.toString();
    const isInitialRun = lastProductCount === null;
    
    // Update Redis with new values
    await redisConnection.set(REDIS_KEY_TOTAL_PAGES, totalPages.toString());
    await redisConnection.set(REDIS_KEY_TOTAL_PRODUCTS, discoveredTotalProducts.toString());
    
    logger.info({ 
      totalPages, 
      totalProducts: discoveredTotalProducts,
      previousPages: previousTotalPages,
      previousProducts: previousTotalProducts
    }, "✅ Page info discovered and stored in Redis (manager will use this)");
  } catch (discoveryError) {
    const errorMessage = discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
    const errorStack = discoveryError instanceof Error ? discoveryError.stack : undefined;
    logger.error({ error: errorMessage, stack: errorStack }, "Failed during discovery phase");
    throw discoveryError;
  }
};

// Track current processing state to prevent duplicates
let isProcessing = false;
let lastProcessedRange: { start: number; end: number } | null = null;

const discoverAndProcessAssignedPages = async (page: Page): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  
  // Prevent duplicate processing
  if (isProcessing) {
    logger.debug({ workerId }, "Already processing, skipping this check");
    return;
  }
  
  try {
    // Discover total pages and products from the encore page
    logger.info({ workerId }, "Starting page and product info discovery from encore page...");
    const { totalPages, totalProducts: discoveredTotalProducts } = await discoverPageInfo(page);
    
    // Update Redis with discovered values (manager will use these)
    await redisConnection.set(REDIS_KEY_TOTAL_PAGES, totalPages.toString());
    await redisConnection.set(REDIS_KEY_TOTAL_PRODUCTS, discoveredTotalProducts.toString());
    
    logger.info({ workerId, totalPages, totalProducts: discoveredTotalProducts }, "Discovered page and product info");
    
    // Check if manager has assigned a page range to this worker
    const assignedPagesStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_PAGES(workerId));
    
    if (!assignedPagesStr) {
      logger.info({ workerId }, "No page range assigned yet by manager. Waiting for assignment...");
      return;
    }
    
    const assignedRange = JSON.parse(assignedPagesStr) as { start: number; end: number };
    
    // Check if this is the same range we're already processing or completed
    if (lastProcessedRange && 
        lastProcessedRange.start === assignedRange.start && 
        lastProcessedRange.end === assignedRange.end) {
      // Check if we've already completed this assignment
      const completeStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId));
      if (completeStr === "1") {
        logger.debug({ workerId, assignedRange }, "Already completed this range. Waiting for new assignment...");
        return;
      }
      
      // Check if we're currently processing this range
      const processingStr = await redisConnection.get(REDIS_KEY_GENERAL_WORKER_PROCESSING(workerId));
      if (processingStr === "1") {
        logger.debug({ workerId, assignedRange }, "Already processing this range. Skipping duplicate...");
        return;
      }
    }
    
    logger.info({ workerId, assignedRange, totalPages }, "Got assigned page range from manager");
    
    // Set processing lock
    isProcessing = true;
    lastProcessedRange = assignedRange;
    await redisConnection.set(REDIS_KEY_GENERAL_WORKER_PROCESSING(workerId), "1");
    await redisConnection.del(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId)); // Clear completion flag
    
    try {
      // Process assigned page range
      await openAllPageTabsInBatches(page, assignedRange.start, assignedRange.end);
      
      logger.info({ workerId, assignedRange }, "✅ Completed processing assigned page range");
    } finally {
      // Clear processing lock
      isProcessing = false;
      await redisConnection.del(REDIS_KEY_GENERAL_WORKER_PROCESSING(workerId));
    }
  } catch (discoveryError) {
    // Clear processing lock on error
    isProcessing = false;
    await redisConnection.del(REDIS_KEY_GENERAL_WORKER_PROCESSING(workerId)).catch(() => {});
    
    const errorMessage = discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
    const errorStack = discoveryError instanceof Error ? discoveryError.stack : undefined;
    logger.error({ error: errorMessage, stack: errorStack, workerId: config.GENERAL_WORKER_ID || 1 }, "Failed during discovery/processing phase");
    throw discoveryError;
  }
};

const checkForDuplicateWorker = async (workerId: number): Promise<boolean> => {
  try {
    const lockKey = REDIS_KEY_WORKER_LOCK("general", workerId);
    const existingLock = await redisConnection.get(lockKey);
    
    if (existingLock) {
      const lockTime = parseInt(existingLock, 10);
      const now = Date.now();
      // If lock is older than 30 seconds, assume previous worker crashed
      if (now - lockTime < 30000) {
        logger.error({ workerId, existingLockTime: new Date(lockTime).toISOString() }, "❌ Another General Worker with the same ID is already running!");
        logger.error({ workerId }, "Please stop the duplicate worker or use a different GENERAL_WORKER_ID");
        return true; // Duplicate found
      }
    }
    
    // Set lock with current timestamp
    await redisConnection.set(lockKey, Date.now().toString());
    return false; // No duplicate
  } catch (error) {
    logger.warn({ error, workerId }, "Failed to check for duplicate worker, continuing anyway");
    return false;
  }
};

const main = async (): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  
  // Check for duplicate worker before starting
  const hasDuplicate = await checkForDuplicateWorker(workerId);
  if (hasDuplicate) {
    process.exit(1);
  }
  
  logger.info({ workerId }, `🚀 General Worker #${workerId} starting...`);
  logger.info({ workerId }, "Standalone worker - will discover pages, send heartbeats to manager, and process assigned page ranges");
  
  // Start heartbeat loop - send heartbeat every 10 seconds
  const HEARTBEAT_INTERVAL = 10000; // 10 seconds
  const sendHeartbeat = async () => {
    try {
      await redisConnection.set(REDIS_KEY_GENERAL_WORKER_HEARTBEAT(workerId), Date.now().toString());
    } catch (error) {
      logger.warn({ error, workerId }, "Failed to send heartbeat");
    }
    setTimeout(sendHeartbeat, HEARTBEAT_INTERVAL);
  };
  sendHeartbeat();
  logger.info({ interval: HEARTBEAT_INTERVAL, workerId }, "Started heartbeat loop");

  try {
    const page = await getPage();
    logger.info({ url: page.url() }, "Got page, current URL");
    
    // Check if we're already on a page with the session
    const currentUrl = page.url();
    if (currentUrl.includes("amazon.com")) {
      logger.info({ url: currentUrl }, "Already on Amazon page");
    }
    
    await ensureLoggedIn(page);
    logger.info({ url: page.url() }, "After ensureLoggedIn, current URL");
    
    // Initial discovery and processing
    await discoverAndProcessAssignedPages(page);
    
    // Set up continuous monitoring - check every 5 seconds for new assignments
    const CHECK_INTERVAL = 5000; // 5 seconds
    
    const continuousCheck = async () => {
      try {
        // Refresh the page to get latest data
        logger.info({ workerId }, "Refreshing page to get latest data...");
        await page.reload({ waitUntil: "load", timeout: 60000 });
        await delay(2000); // Wait for page to fully load
        
        // Discover and process assigned pages
        await discoverAndProcessAssignedPages(page);
        
        logger.info({ interval: CHECK_INTERVAL, workerId }, "Waiting 5 seconds before next check...");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error({ error: errorMessage, stack: errorStack, workerId }, "Error in continuous check - will retry");
        // Continue checking even if there's an error
      }
      
      // Schedule next check
      setTimeout(continuousCheck, CHECK_INTERVAL);
    };
    
    // Start continuous checking
    setTimeout(continuousCheck, CHECK_INTERVAL);
    logger.info({ interval: CHECK_INTERVAL, workerId }, "Started continuous monitoring (every 5 seconds)");
    
    // Keep the process alive
    const shutdown = async (): Promise<void> => {
      logger.info({ workerId }, "General worker shutting down");
      // Clear heartbeat on shutdown
      await redisConnection.del(REDIS_KEY_GENERAL_WORKER_HEARTBEAT(workerId)).catch(() => {});
      await redisConnection.del(REDIS_KEY_WORKER_LOCK("general", workerId)).catch(() => {}); // Release lock
      if (browser) {
        await browser.close().catch(() => {});
      }
      process.exit(0);
    };
    
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    
    logger.info("General worker running continuously - monitoring for changes");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error({ error: errorMessage, stack: errorStack, rawError: error }, "General worker failed");
    process.exit(1);
  }
};

main().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  logger.error({ error: errorMessage, stack: errorStack, rawError: error }, "General worker crashed");
  process.exit(1);
});

