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
        "--remote-debugging-port=9222", // Enable CDP on port 9222 for Product Worker to connect
      ],
      viewport: { width: 1920, height: 1080 },
  };
  
  // Add IPRoyal proxy configuration if enabled
  // If USE_PROXY=false or PROXY_SERVER not configured, use current network IP (no proxy)
  if (config.USE_PROXY && config.PROXY_SERVER) {
    launchOptions.proxy = {
      server: config.PROXY_SERVER, // IPRoyal proxy server
    };
    
    if (config.PROXY_USERNAME && config.PROXY_PASSWORD) {
      launchOptions.proxy.username = config.PROXY_USERNAME; // IPRoyal username
      launchOptions.proxy.password = config.PROXY_PASSWORD; // IPRoyal password
    }
    
    logger.info({ proxy: config.PROXY_SERVER }, "Using IPRoyal proxy for browser");
  } else {
    logger.info("Using current network IP (no proxy)");
  }
  
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

const createNewContextWithProxy = async (batchNumber: number): Promise<BrowserContext> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  const chromePath = config.PLAYWRIGHT_CHROME_EXECUTABLE_PATH;
  
  // Create a new user data dir for this batch (to enable proxy switching)
  // Use batch number to create unique directory per batch
  const baseUserDataDir = config.PLAYWRIGHT_USER_DATA_DIR || "./browser-data";
  const batchUserDataDir = `${baseUserDataDir}-batch-${batchNumber}`;
  
  logger.info({ workerId, batchNumber, userDataDir: batchUserDataDir }, "Creating new browser context with proxy");
  
  const launchOptions: any = {
    headless: config.PLAYWRIGHT_HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
    viewport: { width: 1920, height: 1080 },
  };
  
  // Add IPRoyal proxy configuration if enabled
  // If USE_PROXY=false or PROXY_SERVER not configured, use current network IP (no proxy)
  // Note: IPRoyal typically rotates IPs automatically, but creating a new context
  // ensures a fresh proxy connection for each batch
  if (config.USE_PROXY && config.PROXY_SERVER) {
    launchOptions.proxy = {
      server: config.PROXY_SERVER, // IPRoyal proxy server
    };
    
    if (config.PROXY_USERNAME && config.PROXY_PASSWORD) {
      launchOptions.proxy.username = config.PROXY_USERNAME; // IPRoyal username
      launchOptions.proxy.password = config.PROXY_PASSWORD; // IPRoyal password
    }
    
    logger.info({ workerId, batchNumber, proxy: config.PROXY_SERVER }, "Using IPRoyal proxy for new context");
  } else {
    logger.info({ workerId, batchNumber }, "Using current network IP (no proxy)");
  }
  
  // Only add executablePath if provided
  if (chromePath) {
    launchOptions.executablePath = chromePath;
  }
  
  // Only add sandbox args on Linux
  if (process.platform === "linux") {
    launchOptions.args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
  }
  
  const newContext = await chromium.launchPersistentContext(batchUserDataDir, launchOptions);
  
  // Load shared cookies immediately after creating context
  // Cookies are shared via Redis, so new contexts can use existing session
  await loadSharedCookies(newContext).catch(() => {
    logger.debug("No shared cookies available yet, will load on first login");
  });
  
  logger.info({ workerId, batchNumber }, "✅ Created new browser context with proxy");
  return newContext;
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
    logger.warn({ currentUrl: page.url(), workerId }, "Not logged in. Waiting for manual login...");
    logger.info({ workerId }, "Please log in manually in the browser window. The worker will wait and check periodically.");
    
    // Wait for user to manually log in - check every 5 seconds
    const MAX_WAIT_TIME = 300000; // 5 minutes max wait
    const CHECK_INTERVAL = 5000; // Check every 5 seconds
    const startTime = Date.now();
    
    while (Date.now() - startTime < MAX_WAIT_TIME) {
      await delay(CHECK_INTERVAL);
      
      // Check if page is still open
      if (page.isClosed()) {
        logger.error({ workerId }, "Page was closed while waiting for login");
        throw new Error("Page was closed while waiting for manual login");
      }
      
      // Re-check login status
      const stillSignedIn = await isSignedIn(page);
      if (stillSignedIn) {
        logger.info({ workerId }, "✅ Manual login detected! Logged in successfully");
        // Save cookies to Redis for other workers to use
        await saveSharedCookies(context);
        return; // Success - exit function
      }
      
      logger.debug({ workerId, elapsed: Date.now() - startTime }, "Still waiting for manual login...");
    }
    
    // If we reach here, user didn't log in within the timeout
    logger.error({ workerId, waitTime: MAX_WAIT_TIME }, "Timeout waiting for manual login");
    throw new Error("Timeout waiting for manual login. Please ensure you log in within 5 minutes.");
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
  
  // Open tabs sequentially with random delay between each tab for more human-like behavior
  const startTime = Date.now();
  const batchSize = batchEnd - batchStart + 1;
  
  // Get delay range from config (1-3 seconds as requested)
  const minDelay = config.TAB_OPEN_DELAY_MIN_MS;
  const maxDelay = config.TAB_OPEN_DELAY_MAX_MS;
  
  // Ensure max >= min
  const delayMax = Math.max(minDelay, maxDelay);
  const delayMin = Math.min(minDelay, maxDelay);
  
  for (let pageNum = batchStart; pageNum <= batchEnd; pageNum++) {
    try {
      // Add random delay before opening each tab (1-3 seconds as requested)
      if (pageNum > batchStart) {
        const randomDelay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
        logger.debug({ pageNum, delay: randomDelay }, `Waiting ${randomDelay}ms before opening next tab`);
        await delay(randomDelay);
      }
      
      const encoreUrl = `${config.AMAZON_VINE_ENCORE_URL}&page=${pageNum}`;
      const tab = await targetContext.newPage();
      
      // Navigate with minimal wait - just commit, don't wait for full load
      tab.goto(encoreUrl, { 
        waitUntil: "commit", // Fastest option - just wait for navigation to commit
        timeout: 30000 
      }).catch(() => {
        // Navigation continues in background - non-blocking
      });
      
      logger.debug({ pageNum, encoreUrl }, `Opened tab for page ${pageNum}`);
    } catch (error: any) {
      // Log error but continue
      const errorMsg = error?.message || String(error);
      logger.warn({ error: errorMsg, pageNum }, "Failed to open tab");
    }
  }
  
  const elapsed = Date.now() - startTime;
  logger.info({ elapsed, batchSize, tabsCreated: batchSize, delayRange: `${delayMin}-${delayMax}ms` }, "✅ All tabs created in batch");
  
  return batchSize;
};

// Refresh all tabs with proxy switching (production mode only)
const refreshAllTabsWithProxy = async (): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  const isProduction = config.NODE_ENV === "production";
  
  if (!isProduction) {
    logger.warn({ workerId }, "refreshAllTabsWithProxy called in non-production mode, skipping");
            return;
          }

  try {
    logger.info({ workerId, mode: "production" }, "Starting to refresh all tabs with proxy switching...");
    
    const browserInstance = await getBrowser();
    const allContexts = browserInstance.contexts();
    
    // Get all encore queue pages across all contexts
    const allPages: Page[] = [];
    for (const ctx of allContexts) {
      try {
        const pages = ctx.pages();
        for (const p of pages) {
          if (!p.isClosed()) {
            try {
              const url = p.url();
              if (url.includes("queue=encore") || url.includes("amazon.com/vine")) {
                allPages.push(p);
              }
            } catch {
              // Skip if page is closing
            }
          }
        }
      } catch {
        // Context might be closed, skip it
      }
    }
    
    logger.info({ workerId, totalTabs: allPages.length, mode: "production" }, "Found tabs to refresh");
    
    // If proxy is enabled, create a new context with proxy for refreshing
    if (config.USE_PROXY && config.PROXY_SERVER) {
      // Create a new context with proxy
      const refreshContext = await createNewContextWithProxy(Date.now()); // Use timestamp as batch number for uniqueness
      logger.info({ workerId, mode: "production" }, "Created new context with proxy for refresh");
      
      // Refresh all pages in parallel
      const refreshPromises = allPages.map(async (p) => {
        try {
          if (!p.isClosed()) {
            await p.reload({ waitUntil: "load", timeout: 30000 });
            logger.debug({ workerId, url: p.url() }, "Refreshed tab");
          }
        } catch (error) {
          logger.warn({ workerId, error, url: p.url() }, "Failed to refresh tab");
        }
      });
      
      await Promise.all(refreshPromises);
      logger.info({ workerId, refreshedTabs: allPages.length, mode: "production" }, "✅ Refreshed all tabs");
      
      // Close the refresh context after a delay (it was just for proxy switching)
      setTimeout(async () => {
        try {
          await refreshContext.close();
          logger.info({ workerId }, "Closed refresh context");
        } catch (error) {
          logger.warn({ error }, "Failed to close refresh context");
        }
      }, 5000);
    } else {
      // No proxy - just refresh all pages
      const refreshPromises = allPages.map(async (p) => {
        try {
          if (!p.isClosed()) {
            await p.reload({ waitUntil: "load", timeout: 30000 });
            logger.debug({ workerId, url: p.url() }, "Refreshed tab");
          }
        } catch (error) {
          logger.warn({ workerId, error, url: p.url() }, "Failed to refresh tab");
        }
      });
      
      await Promise.all(refreshPromises);
      logger.info({ workerId, refreshedTabs: allPages.length, mode: "production" }, "✅ Refreshed all tabs (no proxy)");
    }
    
    // Trigger product workers to crawl refreshed pages
    await redisConnection.set(REDIS_KEY_CRAWL_TRIGGER, "1");
    logger.info({ workerId, mode: "production" }, "✅ Triggered product workers to crawl refreshed pages");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, workerId, mode: "production" }, "Failed to refresh all tabs with proxy");
  }
};

const closeBatchTabs = async (targetContext: BrowserContext, batchStart: number, batchEnd: number): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  logger.info({ workerId, batchStart, batchEnd }, "Closing tabs for completed batch");
  
  try {
    // Check if context is accessible (try to get pages to verify it's not closed)
    try {
      targetContext.pages();
    } catch (error: any) {
      logger.warn({ workerId, batchStart, batchEnd, error: error?.message || String(error) }, "Context is not accessible, cannot close tabs");
      return;
    }
    
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
        logger.debug({ error: error?.message || String(error) }, "Skipping page (may be closed or inaccessible)");
      }
    }
    
    if (pagesToClose.length === 0) {
      logger.info({ workerId, batchStart, batchEnd, totalPages: pages.length }, "No tabs found to close for this batch (may already be closed)");
      return;
    }
    
    // Close all matching pages in parallel for efficiency
    const closePromises = pagesToClose.map(async (page) => {
      try {
        // Double-check page is still open and accessible
        if (page.isClosed()) {
          return false;
        }
        
        // Verify the page URL still matches before closing
        try {
          const url = page.url();
          const pageMatch = url.match(/[?&]page=(\d+)/);
          if (pageMatch) {
            const pageNum = parseInt(pageMatch[1], 10);
            if (pageNum >= batchStart && pageNum <= batchEnd) {
              await page.close();
              return true;
            }
          }
        } catch {
          // Page might have been closed or navigated away, skip it
          return false;
        }
        return false;
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        logger.debug({ error: errorMsg }, "Error closing individual tab");
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
    } catch (error: any) {
      // Better error logging
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error({ 
        error: errorMessage, 
        errorStack,
        workerId, 
        batchStart, 
        batchEnd
      }, "Error closing batch tabs");
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
  
  // Clear old page assignments for all active workers first to prevent caching issues
  logger.info({ activeWorkers }, "Clearing old page assignments for active workers to prevent caching...");
  for (const workerId of activeWorkers) {
    await redisConnection.del(REDIS_KEY_WORKER_PAGES(workerId));
  }
  
  // Small delay to ensure workers see the cleared state
  await delay(100);
  
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

const openAllPageTabsInBatches = async (page: Page, assignedStartPage: number, assignedEndPage: number, onFirstLoopComplete?: () => void): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  try {
    logger.info({ workerId, assignedStartPage, assignedEndPage, totalPages: assignedEndPage - assignedStartPage + 1 }, "Starting to open assigned page tabs in batches");
    
    const TABS_PER_BATCH = config.TABS_PER_BATCH || 20;
    const MAX_TABS_BEFORE_CLEANUP = 100; // Memory optimization: close tabs when reaching 100
    const isDevelopment = config.NODE_ENV === "development";
    const isProduction = config.NODE_ENV === "production";
    let totalTabsOpened = 0;
    let previousBatchContext: BrowserContext | null = null;
    const batchContexts: Array<{ batchStart: number; batchEnd: number; context: BrowserContext; completed: boolean }> = [];
    
    // Helper function to count total open tabs across all contexts (only encore queue pages)
    const countTotalOpenTabs = async (): Promise<number> => {
      try {
        const browserInstance = await getBrowser();
        let totalTabs = 0;
        const allContexts = browserInstance.contexts();
        for (const ctx of allContexts) {
          try {
            const pages = ctx.pages();
            // Count only encore queue pages (not DevTools or other pages)
            for (const p of pages) {
              if (!p.isClosed()) {
                try {
                  const url = p.url();
                  if (url.includes("queue=encore") || url.includes("amazon.com/vine")) {
                    totalTabs++;
                  }
                } catch {
                  // Page might be closing, skip it
                }
              }
            }
          } catch {
            // Context might be closed, skip it
          }
        }
        return totalTabs;
      } catch {
        return 0;
      }
    };
    
    // Helper function to close completed batches (oldest first)
    const closeCompletedBatches = async (): Promise<number> => {
      // Find batches that are completed (product workers finished crawling)
      const completedBatches = batchContexts.filter(b => b.completed);
      
      if (completedBatches.length === 0) {
        return 0;
      }
      
      // Sort by batch start (oldest first) - close oldest batches first
      completedBatches.sort((a, b) => a.batchStart - b.batchStart);
      
      logger.info({ workerId, completedBatchesCount: completedBatches.length }, "Closing completed batches for memory optimization");
      
      let closedTabCount = 0;
      for (const batch of completedBatches) {
        try {
          // Check if context is accessible
          try {
            batch.context.pages();
          } catch {
            // Context is closed or not accessible, remove from tracking
            const index = batchContexts.findIndex(b => b.batchStart === batch.batchStart && b.batchEnd === batch.batchEnd);
            if (index !== -1) {
              batchContexts.splice(index, 1);
            }
            continue;
          }
          
          // Close tabs for this batch
          await closeBatchTabs(batch.context, batch.batchStart, batch.batchEnd);
          closedTabCount += (batch.batchEnd - batch.batchStart + 1);
          logger.info({ workerId, batchStart: batch.batchStart, batchEnd: batch.batchEnd }, "✅ Closed completed batch tabs");
          
          // Remove from tracking (batch is closed)
          const index = batchContexts.findIndex(b => b.batchStart === batch.batchStart && b.batchEnd === batch.batchEnd);
          if (index !== -1) {
            batchContexts.splice(index, 1);
          }
        } catch (error: any) {
          // Better error logging
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;
          logger.warn({ 
            error: errorMessage, 
            errorStack,
            batchStart: batch.batchStart, 
            batchEnd: batch.batchEnd
          }, "Failed to close completed batch");
        }
      }
      
      return closedTabCount;
    };
    
    // Process assigned pages in batches
    for (let batchStart = assignedStartPage; batchStart <= assignedEndPage; batchStart += TABS_PER_BATCH) {
      const batchEnd = Math.min(batchStart + TABS_PER_BATCH - 1, assignedEndPage);
      const batchNumber = Math.ceil((batchStart - assignedStartPage) / TABS_PER_BATCH) + 1;
      
      // Get current tab count (used for logging and cleanup decisions)
      const currentTabCount = await countTotalOpenTabs();
      
      // Check total open tabs - only close tabs in development mode
      // In production mode, keep all tabs open and refresh them instead
      if (isDevelopment) {
        if (currentTabCount >= MAX_TABS_BEFORE_CLEANUP) {
          logger.info({ workerId, currentTabCount, maxTabs: MAX_TABS_BEFORE_CLEANUP, mode: "development" }, "⚠️ Reached tab limit (development mode), waiting for product workers to finish and closing completed batches...");
          
          // Wait for product workers to complete current batches
          await waitForBatchCompletion();
          
          // Mark all existing batches as completed (they've been crawled by product workers)
          // We'll close the oldest batches first to free memory
          for (const batch of batchContexts) {
            if (!batch.completed) {
              batch.completed = true;
            }
          }
          
          // Close completed batches to free memory (oldest first)
          const closedTabCount = await closeCompletedBatches();
          
          // Re-check tab count after cleanup
          const tabCountAfterCleanup = await countTotalOpenTabs();
          logger.info({ workerId, tabsBefore: currentTabCount, tabsAfter: tabCountAfterCleanup, closedTabs: closedTabCount }, "✅ Memory cleanup completed (development mode)");
        } else {
          // Even if we haven't reached the limit, close old completed batches periodically
          // This ensures we don't accumulate too many tabs
          // Check if we have any completed batches that can be closed
          const completedBatches = batchContexts.filter(b => b.completed);
          if (completedBatches.length > 0 && currentTabCount > TABS_PER_BATCH * 2) {
            // If we have more than 2 batches worth of tabs, close old completed batches
            logger.info({ workerId, currentTabCount, completedBatches: completedBatches.length, mode: "development" }, "Closing old completed batches to free memory...");
            const closedTabCount = await closeCompletedBatches();
            if (closedTabCount > 0) {
              logger.info({ workerId, closedTabs: closedTabCount, mode: "development" }, "✅ Closed old completed batches");
            }
          }
        }
      } else {
        // Production mode: don't close tabs, just log the count
        if (currentTabCount >= MAX_TABS_BEFORE_CLEANUP) {
          logger.info({ workerId, currentTabCount, maxTabs: MAX_TABS_BEFORE_CLEANUP, mode: "production" }, "⚠️ Reached tab limit (production mode), keeping tabs open for refresh cycle");
        }
      }
      
      // Create new context with proxy for this batch (switches proxy for each batch)
      let targetContext: BrowserContext;
      if (config.USE_PROXY && config.PROXY_SERVER) {
        // Create new context with proxy for this batch
        targetContext = await createNewContextWithProxy(batchNumber);
        batchContexts.push({ batchStart, batchEnd, context: targetContext, completed: false });
        logger.info({ workerId, batchStart, batchEnd, batchNumber }, "✅ Created new context with proxy for this batch");
      } else {
        // Use existing context if proxy is not enabled
        const browserInstance = await getBrowser();
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
        // Track this batch in the main context
        batchContexts.push({ batchStart, batchEnd, context: targetContext, completed: false });
      }
      
      logger.info({ workerId, batchStart, batchEnd, assignedStartPage, assignedEndPage, batchNumber, tabsPerBatch: TABS_PER_BATCH, currentTabCount }, "Starting new batch");
      
      // Set current batch info in Redis
      await redisConnection.set(REDIS_KEY_CURRENT_BATCH_START, batchStart.toString());
      await redisConnection.set(REDIS_KEY_CURRENT_BATCH_END, batchEnd.toString());
      await redisConnection.del(REDIS_KEY_BATCH_COMPLETE); // Clear completion flag
      await redisConnection.del(REDIS_KEY_TABS_READY); // Clear ready flag
      
      // Open this batch of tabs (with 1-3 second random delay between each tab)
      const tabsOpened = await openBatchOfTabs(targetContext, batchStart, batchEnd, assignedEndPage, totalTabsOpened);
      totalTabsOpened += tabsOpened;
      
      logger.info({ workerId, batchStart, batchEnd, tabsOpened, totalTabsOpened }, "✅ Batch of tabs opened");
      
      // Distribute pages among all active product workers BEFORE triggering them
      const pages = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);
      await distributePagesToWorkers(pages);
      
      // Mark tabs as ready and trigger product workers to crawl this batch
      // Note: Workers will crawl this batch while we continue to open the next batch
      await redisConnection.set(REDIS_KEY_TABS_READY, "1");
      await redisConnection.set(REDIS_KEY_CRAWL_TRIGGER, "1");
      logger.info({ workerId, batchStart, batchEnd }, "✅ Tabs ready - assigned pages and triggered product workers to crawl this batch (workers will crawl in parallel)");
      
      // Close previous batch's context only in development mode
      // In production mode, keep all contexts open for refresh cycle
      // IMPORTANT: Only close tabs after product workers have finished crawling them
      if (isDevelopment && previousBatchContext) {
        // Wait for product workers to finish crawling the previous batch before closing tabs
        // This ensures we don't close tabs that are still being used by product workers
        (async () => {
          try {
            // Find the previous batch info
            let prevBatch = batchContexts.find(b => b.context === previousBatchContext);
            
            // If not found and not using proxy, find by batch range (since all share same context)
            if (!prevBatch && !config.USE_PROXY) {
              // Find the batch that was just before the current one
              const previousBatchEnd = batchStart - 1;
              prevBatch = batchContexts.find(b => b.batchEnd === previousBatchEnd);
            }
            
            if (!prevBatch || !previousBatchContext) {
              logger.warn({ workerId, batchStart, previousBatchContext: previousBatchContext ? "exists" : "null" }, "Previous batch not found in batchContexts, cannot close tabs");
              return;
            }
            
            const prevBatchStart = prevBatch.batchStart;
            const prevBatchEnd = prevBatch.batchEnd;
            
            logger.info({ 
              workerId, 
              batchStart: prevBatchStart, 
              batchEnd: prevBatchEnd, 
              mode: "development" 
            }, "Waiting for product workers to finish crawling previous batch before closing tabs...");
            
            // Wait for product workers to complete the previous batch
            // Check REDIS_KEY_BATCH_COMPLETE flag - it's set to "1" when all workers finish
            const maxWaitTime = 300000; // 5 minutes max wait
            const checkInterval = 2000; // Check every 2 seconds
            const startWaitTime = Date.now();
            let batchComplete = false;
            
            while (!batchComplete && (Date.now() - startWaitTime) < maxWaitTime) {
              const completeStr = await redisConnection.get(REDIS_KEY_BATCH_COMPLETE);
              if (completeStr === "1") {
                batchComplete = true;
                logger.info({ 
                  workerId, 
                  batchStart: prevBatchStart, 
                  batchEnd: prevBatchEnd 
                }, "✅ Product workers finished crawling previous batch - safe to close tabs");
                break;
              }
              
              // Also check if all workers have no pages assigned (alternative completion check)
              // Get active workers using the same detection method
              const activeWorkers = await detectActiveWorkers();
              
              let allWorkersDone = true;
              for (const workerId of activeWorkers) {
                const pagesStr = await redisConnection.get(REDIS_KEY_WORKER_PAGES(workerId));
                if (pagesStr) {
                  const pages = JSON.parse(pagesStr) as number[];
                  // Check if any pages in the previous batch range are still assigned
                  const hasPreviousBatchPages = pages.some(p => p >= prevBatchStart && p <= prevBatchEnd);
                  if (hasPreviousBatchPages) {
                    allWorkersDone = false;
                    break;
                  }
                }
              }
              
              if (allWorkersDone) {
                batchComplete = true;
                logger.info({ 
                  workerId, 
                  batchStart: prevBatchStart, 
                  batchEnd: prevBatchEnd 
                }, "✅ All product workers finished crawling previous batch (no pages assigned) - safe to close tabs");
                break;
              }
              
              await delay(checkInterval);
            }
            
            if (!batchComplete) {
              logger.warn({ 
                workerId, 
                batchStart: prevBatchStart, 
                batchEnd: prevBatchEnd,
                waitTime: Date.now() - startWaitTime 
              }, "Timeout waiting for product workers to finish - closing tabs anyway (may interrupt workers)");
            }
            
            // Now close the tabs for the previous batch
            logger.info({ 
              workerId, 
              batchStart: prevBatchStart, 
              batchEnd: prevBatchEnd, 
              mode: "development" 
            }, "Attempting to close previous batch tabs...");
            
            try {
              await closeBatchTabs(previousBatchContext, prevBatchStart, prevBatchEnd);
              logger.info({ 
                workerId, 
                batchStart: prevBatchStart, 
                batchEnd: prevBatchEnd, 
                mode: "development" 
              }, "✅ Closed previous batch tabs");
            } catch (closeError: any) {
              const errorMsg = closeError instanceof Error ? closeError.message : String(closeError);
              const errorStack = closeError instanceof Error ? closeError.stack : undefined;
              logger.warn({ 
                error: errorMsg, 
                errorStack,
                batchStart: prevBatchStart, 
                batchEnd: prevBatchEnd 
              }, "Failed to close previous batch tabs");
            }
            
            // Close the context after a delay to ensure workers finished (only if using proxy)
            // If not using proxy, we're using the same context, so don't close it
            if (config.USE_PROXY && config.PROXY_SERVER) {
              const contextToClose = previousBatchContext; // Capture for closure
              if (contextToClose) {
                setTimeout(async () => {
                  try {
                    // Check if context is still accessible before closing
                    try {
                      contextToClose.pages();
                      await contextToClose.close();
                      logger.info({ workerId }, "✅ Closed previous batch context");
                    } catch {
                      logger.debug({ workerId }, "Previous batch context already closed or not accessible");
                    }
                  } catch (error: any) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.warn({ error: errorMsg }, "Failed to close previous batch context");
                  }
                }, 5000); // Wait 5 seconds before closing context
              }
            } else {
              logger.debug({ workerId, mode: "development" }, "Not closing context (no proxy - using shared context)");
            }
          } catch (error: any) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            logger.warn({ 
              error: errorMsg, 
              errorStack,
              batchStart 
            }, "Failed to close previous batch");
          }
        })(); // Immediately invoke async function (fire and forget)
      } else if (isProduction && previousBatchContext) {
        logger.debug({ workerId, mode: "production" }, "Keeping previous batch context open for refresh cycle");
      }
      
      // Update previous batch context for next iteration
      previousBatchContext = targetContext;
      
      // Small delay before opening next batch (allows workers to start processing)
      if (batchStart + TABS_PER_BATCH <= assignedEndPage) {
        await delay(1000);
      }
    }
    
    // Wait for the last batch to complete
    logger.info({ workerId }, "Waiting for final batch to complete...");
    await waitForBatchCompletion();
    
    // Close the last batch's context only in development mode
    if (isDevelopment && previousBatchContext) {
      const lastBatch = batchContexts[batchContexts.length - 1];
      if (lastBatch) {
        await closeBatchTabs(previousBatchContext, lastBatch.batchStart, lastBatch.batchEnd);
        await delay(2000);
        // Only close context if using proxy (separate contexts)
        // If not using proxy, we're using the shared context, so don't close it
        if (config.USE_PROXY && config.PROXY_SERVER) {
          await previousBatchContext.close();
          logger.info({ workerId, mode: "development" }, "✅ Closed final batch context");
        } else {
          logger.debug({ workerId, mode: "development" }, "Not closing final context (no proxy - using shared context)");
        }
      }
    }
    
    logger.info({ workerId, totalTabs: totalTabsOpened, totalPages: assignedEndPage - assignedStartPage + 1, mode: isProduction ? "production" : "development" }, "✅ All batches processed - all assigned page tabs opened and crawled");
    
    // Mark first loop as completed (for production mode refresh cycle)
    if (onFirstLoopComplete) {
      onFirstLoopComplete();
    }
    
    // In production mode, start refresh cycle after first loop
    if (isProduction) {
      logger.info({ workerId, mode: "production" }, "✅ First loop completed. Starting refresh cycle with proxy switching...");
      // Don't mark as complete - we'll continue with refresh cycle
      // The refresh cycle will be handled in the continuous check loop
    } else {
      // Mark this general worker as complete in development mode
      await redisConnection.set(REDIS_KEY_GENERAL_WORKER_COMPLETE(workerId), "1");
      logger.info({ workerId, mode: "development" }, "✅ General worker completed assigned page range");
      }
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

const discoverAndProcessAssignedPages = async (page: Page, onFirstLoopComplete?: () => void): Promise<void> => {
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
      await openAllPageTabsInBatches(page, assignedRange.start, assignedRange.end, onFirstLoopComplete);
      
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

const checkForDuplicateWorker = async (workerId: number): Promise<{ hasDuplicate: boolean; lockValue?: string }> => {
  try {
    const lockKey = REDIS_KEY_WORKER_LOCK("general", workerId);
    const lockValue = Date.now().toString();
    const LOCK_TTL_SECONDS = 60; // Lock expires after 60 seconds (allows recovery from crashes)
    
    // Atomic operation: SET if Not eXists with EXpiration
    // Returns "OK" if lock was acquired, null if lock already exists
    const result = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
    
    if (result === "OK") {
      // Successfully acquired the lock atomically
      return { hasDuplicate: false, lockValue }; // Return lock value for later verification
    }
    
    // Lock already exists - check if it's stale (from a crashed worker)
    const existingLock = await redisConnection.get(lockKey);
    if (existingLock) {
      const lockTime = parseInt(existingLock, 10);
      const now = Date.now();
      // If lock is older than 30 seconds, assume previous worker crashed
      if (now - lockTime < 30000) {
        logger.error({ workerId, existingLockTime: new Date(lockTime).toISOString() }, "❌ Another General Worker with the same ID is already running!");
        logger.error({ workerId }, "Please stop the duplicate worker or use a different GENERAL_WORKER_ID");
        return { hasDuplicate: true }; // Duplicate found
      }
      
      // Lock is stale (older than 30 seconds) - try to acquire it
      // Use GETSET to atomically get old value and set new value
      const oldValue = await redisConnection.getset(lockKey, lockValue);
      if (oldValue === existingLock) {
        // Successfully acquired stale lock
        await redisConnection.expire(lockKey, LOCK_TTL_SECONDS);
        return { hasDuplicate: false, lockValue }; // Return lock value for later verification
      } else if (oldValue === null) {
        // Lock expired between GET and GETSET - retry with SET NX
        const retryResult = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
        if (retryResult === "OK") {
          return { hasDuplicate: false, lockValue }; // Return lock value for later verification
        }
        // Another process acquired it during retry - check if it's a real duplicate
        const newLock = await redisConnection.get(lockKey);
        if (newLock) {
          const newLockTime = parseInt(newLock, 10);
          const now = Date.now();
          if (now - newLockTime < 30000) {
            // New lock is recent - real duplicate
            logger.error({ workerId }, "❌ Another General Worker with the same ID is already running!");
            return { hasDuplicate: true }; // Duplicate found
          }
        }
        // Lock is still stale or doesn't exist - try one more time
        const finalRetry = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
        if (finalRetry === "OK") {
          return { hasDuplicate: false, lockValue }; // Return lock value for later verification
        }
        logger.error({ workerId }, "❌ Another General Worker with the same ID is already running!");
        return { hasDuplicate: true }; // Duplicate found
      } else {
        // oldValue is different from existingLock - lock was modified
        // Could be another process or lock refresh - check if it's recent
        const newLockTime = parseInt(oldValue, 10);
        const now = Date.now();
        if (now - newLockTime < 30000) {
          // New lock is recent - real duplicate
          logger.error({ workerId }, "❌ Another General Worker with the same ID is already running!");
          return { hasDuplicate: true }; // Duplicate found
        }
        // New lock is also stale - retry with SET NX
        const retryResult = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
        if (retryResult === "OK") {
          return { hasDuplicate: false, lockValue }; // Return lock value for later verification
        }
        logger.error({ workerId }, "❌ Another General Worker with the same ID is already running!");
        return { hasDuplicate: true }; // Duplicate found
      }
    }
    
    // Lock doesn't exist (expired between SET NX and GET) - try again
    const retryResult = await redisConnection.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
    if (retryResult === "OK") {
      return { hasDuplicate: false, lockValue }; // Return lock value for later verification
    }
    
    // Still couldn't acquire - another worker must have started
    logger.error({ workerId }, "❌ Another General Worker with the same ID is already running!");
    return { hasDuplicate: true }; // Duplicate found
  } catch (error) {
    logger.warn({ error, workerId }, "Failed to check for duplicate worker, continuing anyway");
    return { hasDuplicate: false }; // Continue on error (no lock value to verify)
  }
};

const main = async (): Promise<void> => {
  const workerId = config.GENERAL_WORKER_ID || 1;
  
  // Check for duplicate worker before starting
  const duplicateCheck = await checkForDuplicateWorker(workerId);
  if (duplicateCheck.hasDuplicate) {
    process.exit(1);
  }
  
  // Store the lock value we acquired for verification during refresh
  let ourLockValue = duplicateCheck.lockValue;
  
  // If lock value wasn't returned (e.g., due to error in checkForDuplicateWorker),
  // try to retrieve it from Redis to ensure lastRefreshTime matches the actual lock timestamp
  if (!ourLockValue) {
    try {
      const lockKey = REDIS_KEY_WORKER_LOCK("general", workerId);
      const lockFromRedis = await redisConnection.get(lockKey);
      if (lockFromRedis) {
        ourLockValue = lockFromRedis;
        logger.info({ workerId }, "Retrieved lock value from Redis after duplicate check error");
      } else {
        // Lock doesn't exist in Redis - we can't verify we own it
        // Fail-fast to prevent running without proper duplicate prevention
        logger.error({ workerId }, "❌ Cannot verify lock acquisition - lock not found in Redis");
        logger.error({ workerId }, "Worker cannot proceed without verified lock ownership. Exiting to prevent duplicate workers.");
        process.exit(1);
      }
    } catch (error) {
      // Redis retrieval failed - we can't verify lock ownership
      // Fail-fast to prevent running without proper duplicate prevention
      logger.error({ error, workerId }, "❌ Failed to retrieve lock value from Redis");
      logger.error({ workerId }, "Worker cannot proceed without verified lock ownership. Exiting to prevent duplicate workers.");
      process.exit(1);
    }
  }
  
  logger.info({ workerId }, `🚀 General Worker #${workerId} starting...`);
  logger.info({ workerId }, "Standalone worker - will discover pages, send heartbeats to manager, and process assigned page ranges");
  
  // Track if first loop is completed (for production mode refresh cycle)
  let firstLoopCompleted = false;
  
  // Define environment mode flags (used in continuousCheck and openAllPageTabsInBatches)
  const isDevelopment = config.NODE_ENV === "development";
  const isProduction = config.NODE_ENV === "production";
  
  // Start heartbeat loop - send heartbeat every 10 seconds
  const HEARTBEAT_INTERVAL = 10000; // 10 seconds
  const LOCK_TTL_SECONDS = 60; // Lock TTL matches the one used in checkForDuplicateWorker
  
  // Track last successful refresh time to detect if lock was stolen
  // Use the actual lock value from Redis to ensure it matches what's stored
  let lastRefreshTime = ourLockValue ? parseInt(ourLockValue, 10) : Date.now();
  
  const refreshLock = async (): Promise<void> => {
    try {
      const lockKey = REDIS_KEY_WORKER_LOCK("general", workerId);
      const now = Date.now();
      
      // Get current lock value to verify we still own it
      const currentLock = await redisConnection.get(lockKey);
      
      if (!currentLock) {
        // Lock doesn't exist - we no longer own it (expired or released)
        logger.debug({ workerId }, "Lock doesn't exist - not refreshing");
        return;
      }
      
      const currentLockTime = parseInt(currentLock, 10);
      
      // Validate that currentLockTime is a valid number
      // If Redis contains invalid data, parseInt returns NaN, which breaks ownership verification
      if (isNaN(currentLockTime)) {
        logger.warn({ workerId, invalidLockValue: currentLock }, "Lock value is not a valid number - not refreshing");
        return;
      }
      
      // Verify ownership: current lock should be close to our last refresh time
      // Since we refresh every 10 seconds (HEARTBEAT_INTERVAL), the lock value should be
      // within 15-20 seconds of our last refresh. A larger gap indicates another worker acquired it.
      // Use a tight threshold (20 seconds) to detect lock theft quickly
      const LOCK_OWNERSHIP_THRESHOLD_MS = 20000; // 20 seconds - tighter than TTL to catch theft early
      if (Math.abs(currentLockTime - lastRefreshTime) > LOCK_OWNERSHIP_THRESHOLD_MS) {
        logger.warn({ workerId, lastRefreshTime, currentLockTime, diff: Math.abs(currentLockTime - lastRefreshTime) }, "Lock appears to be from another worker - not refreshing");
        return;
      }
      
      // We still own the lock - refresh it atomically using GETSET
      const newLockValue = now.toString();
      const oldValue = await redisConnection.getset(lockKey, newLockValue);
      
      // Check if lock expired between GET and GETSET (oldValue is null)
      if (oldValue === null) {
        // Lock expired between GET and GETSET - we no longer own it
        // Another worker may have acquired it or it expired
        logger.warn({ workerId, expected: currentLock }, "Lock expired during refresh (GETSET returned null) - lock lost");
        return;
      }
      
      // Verify the old value matches what we expected
      // If oldValue doesn't match currentLock, another worker modified it
      if (oldValue !== currentLock) {
        // Lock was modified by another worker between GET and GETSET - revert our change
        await redisConnection.set(lockKey, oldValue, "EX", LOCK_TTL_SECONDS);
        logger.warn({ workerId, expected: currentLock, actual: oldValue }, "Lock was modified by another worker during refresh - reverted");
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
      logger.debug({ error, workerId }, "Failed to refresh lock");
    }
  };
  
  const sendHeartbeat = async () => {
    try {
      await redisConnection.set(REDIS_KEY_GENERAL_WORKER_HEARTBEAT(workerId), Date.now().toString());
      // Refresh lock to prevent expiration while worker is running
      await refreshLock();
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
    
    // Try to ensure logged in - if it fails, keep retrying instead of exiting
    let loggedIn = false;
    let loginAttempts = 0;
    const MAX_LOGIN_ATTEMPTS = 10; // Try up to 10 times (50 minutes total)
    
    while (!loggedIn && loginAttempts < MAX_LOGIN_ATTEMPTS) {
      try {
    await ensureLoggedIn(page);
        loggedIn = true;
        logger.info({ url: page.url() }, "After ensureLoggedIn, current URL");
      } catch (loginError) {
        loginAttempts++;
        const errorMessage = loginError instanceof Error ? loginError.message : String(loginError);
        logger.warn({ workerId, attempt: loginAttempts, maxAttempts: MAX_LOGIN_ATTEMPTS, error: errorMessage }, "Login failed, will retry...");
        
        // Wait 30 seconds before retrying (give user more time to login)
        logger.info({ workerId, waitTime: 30000 }, "Waiting 30 seconds before retrying login check...");
        await delay(30000);
        
        // Check if page is still open
        if (page.isClosed()) {
          logger.error({ workerId }, "Page was closed, cannot continue");
          throw new Error("Page was closed during login retry");
        }
      }
    }
    
    if (!loggedIn) {
      logger.error({ workerId, attempts: loginAttempts }, "Failed to login after multiple attempts. Please check the browser and try again.");
      // Don't exit - keep the browser open so user can manually login
      // The continuous check will retry later
      logger.info({ workerId }, "Worker will continue running. Please login manually and the worker will detect it on the next check.");
    }
    
    // Initial discovery and processing (only if logged in)
    if (loggedIn) {
      await discoverAndProcessAssignedPages(page, () => {
        firstLoopCompleted = true;
      });
    }
    
    // Set up continuous monitoring - infinite loop for continuous processing
    const CHECK_INTERVAL = 5000; // 5 seconds between checks
    
    const continuousCheck = async (): Promise<void> => {
      try {
        // Check if page is still open
        if (page.isClosed()) {
          logger.warn({ workerId }, "Page was closed, attempting to get new page...");
          try {
            const newPage = await getPage();
            Object.assign(page, newPage); // Replace page reference
            logger.info({ workerId }, "Got new page, continuing...");
  } catch (error) {
            logger.error({ error, workerId }, "Failed to get new page, will retry in next cycle");
            setTimeout(continuousCheck, CHECK_INTERVAL);
            return;
          }
        }
        
        // Check login status
        const signedIn = await isSignedIn(page);
        if (!signedIn) {
          logger.info({ workerId }, "Not logged in yet, checking login status...");
          try {
            await ensureLoggedIn(page);
            logger.info({ workerId }, "✅ Login detected during continuous check!");
          } catch (loginError) {
            logger.debug({ workerId, error: loginError instanceof Error ? loginError.message : String(loginError) }, "Still waiting for login...");
            // Continue to next check - don't throw error
            setTimeout(continuousCheck, CHECK_INTERVAL);
            return;
          }
        }
        
        // Only proceed with discovery if logged in
        const stillSignedIn = await isSignedIn(page);
        if (stillSignedIn) {
          // In production mode, after first loop, check for changes and refresh tabs
          if (isProduction && firstLoopCompleted) {
            // Get current totalPages and totalProducts from Redis
            const currentTotalPagesStr = await redisConnection.get(REDIS_KEY_TOTAL_PAGES);
            const currentTotalProductsStr = await redisConnection.get(REDIS_KEY_TOTAL_PRODUCTS);
            
            // Discover new values
            const { totalPages: newTotalPages, totalProducts: newTotalProducts } = await discoverPageInfo(page);
            
            // Update Redis with new values
            await redisConnection.set(REDIS_KEY_TOTAL_PAGES, newTotalPages.toString());
            await redisConnection.set(REDIS_KEY_TOTAL_PRODUCTS, newTotalProducts.toString());
            
            const currentTotalPages = currentTotalPagesStr ? parseInt(currentTotalPagesStr, 10) : 0;
            const currentTotalProducts = currentTotalProductsStr ? parseInt(currentTotalProductsStr, 10) : 0;
            
            const pagesChanged = currentTotalPages !== newTotalPages;
            const productsChanged = currentTotalProducts !== newTotalProducts;
            
            if (pagesChanged || productsChanged) {
              logger.info({ 
                workerId, 
                mode: "production",
                oldPages: currentTotalPages, 
                newPages: newTotalPages,
                oldProducts: currentTotalProducts,
                newProducts: newTotalProducts,
                pagesChanged,
                productsChanged
              }, "⚠️ Detected changes in totalPages or totalProducts! Refreshing all tabs with new proxy...");
              
              // Refresh all tabs with proxy switching
              await refreshAllTabsWithProxy();
            } else {
              logger.debug({ workerId, mode: "production", totalPages: newTotalPages, totalProducts: newTotalProducts }, "No changes detected, continuing monitoring...");
            }
          } else {
            // Normal discovery and processing (first loop or development mode)
            // Refresh the page to get latest data
            logger.info({ workerId }, "Refreshing page to get latest data...");
            try {
              await page.reload({ waitUntil: "load", timeout: 60000 });
              await delay(2000); // Wait for page to fully load
              
              // Discover and process assigned pages (this will loop continuously)
              await discoverAndProcessAssignedPages(page, () => {
                firstLoopCompleted = true;
              });
            } catch (reloadError) {
              const errorMessage = reloadError instanceof Error ? reloadError.message : String(reloadError);
              logger.warn({ workerId, error: errorMessage }, "Error during page reload, will retry");
            }
          }
        }
        
        logger.info({ interval: CHECK_INTERVAL, workerId }, "Completed cycle, continuing loop...");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error({ error: errorMessage, stack: errorStack, workerId }, "Error in continuous check - will retry");
        // Continue checking even if there's an error - never stop the loop
      }
      
      // Always schedule next check - infinite loop
      setTimeout(continuousCheck, CHECK_INTERVAL);
    };
    
    // Start continuous checking - infinite loop
    setTimeout(continuousCheck, CHECK_INTERVAL);
    logger.info({ interval: CHECK_INTERVAL, workerId }, "Started continuous monitoring loop (infinite loop, will process pages continuously)");
    
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

