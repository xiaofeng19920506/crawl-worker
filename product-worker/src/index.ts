import { chromium, Browser, BrowserContext, Page } from "playwright";
import {
  config,
  logger,
  createWorker,
  closeQueueResources,
  ProductJobData,
  upsertProduct,
  recordCrawlEvent,
  getProductsByPage,
  deleteProductsByPageNumber,
  redisConnection,
  REDIS_KEY_TOTAL_PAGES,
  REDIS_KEY_TOTAL_PRODUCTS,
  REDIS_KEY_CRAWL_TRIGGER,
  REDIS_KEY_LAST_PRODUCT_COUNT,
  REDIS_KEY_TABS_READY,
  REDIS_KEY_CURRENT_BATCH_START,
  REDIS_KEY_CURRENT_BATCH_END,
  REDIS_KEY_BATCH_COMPLETE,
  REDIS_KEY_WORKER_PAGES,
  REDIS_KEY_WORKER_COMPLETE,
  REDIS_KEY_WORKER_HEARTBEAT,
} from "shared";
import { Job } from "bullmq";
import { setTimeout as delay } from "node:timers/promises";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
const activePages = new Map<string, Page>();

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
  logger.info("Successfully launched new browser");
  return browser;
};

const getOrCreatePage = async (tabId: string): Promise<Page> => {
  if (activePages.has(tabId)) {
    const page = activePages.get(tabId)!;
    if (!page.isClosed()) {
      return page;
    }
    activePages.delete(tabId);
  }

  const browserInstance = await getBrowser();
  let page: Page;

  if (context) {
    page = await context.newPage();
  } else {
    // For CDP connections, try to use existing context or create new one
    const contexts = browserInstance.contexts();
    let targetContext: BrowserContext;
    
    if (contexts.length > 0) {
      targetContext = contexts[0];
    } else {
      targetContext = await browserInstance.newContext({
        viewport: { width: 1920, height: 1080 },
      });
    }
    
    page = await targetContext.newPage();
  }

  activePages.set(tabId, page);
  return page;
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

    return false;
  } catch {
    return false;
  }
};

const ensureLoggedIn = async (page: Page): Promise<void> => {
  // Check if we're already on an Amazon page and logged in
  const currentUrl = page.url();
  if (currentUrl.includes("amazon.com") && !currentUrl.includes("/ap/signin") && !currentUrl.includes("/signin")) {
    const signedIn = await isSignedIn(page);
    if (signedIn) {
      logger.info("Already logged in on current page");
      return;
    }
  }

  // Navigate to encore queue page to check login status (same page we'll be crawling)
  await page.goto(config.AMAZON_VINE_ENCORE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Check if we were redirected to sign-in
  const newUrl = page.url();
  if (newUrl.includes("/ap/signin") || newUrl.includes("/signin")) {
    logger.error({ currentUrl: newUrl }, "Not logged in - redirected to sign-in page");
    throw new Error("Not logged in. Please log in via VNC at http://localhost:6080/vnc.html");
  }

  const signedIn = await isSignedIn(page);
  if (!signedIn) {
    logger.error({ currentUrl: page.url() }, "Not logged in. Please log in via VNC.");
    throw new Error("Not logged in. Please log in via VNC at http://localhost:6080/vnc.html");
  }
  
  logger.info("Login verified");
};

const extractProductsFromPage = async (page: Page, pageNumber: number): Promise<any[]> => {
  logger.info({ pageNumber }, "Extracting products from encore page");
  
  // Wait for page to load
  await delay(3000);
  
  const products = await page.evaluate((pageNum) => {
    const extracted: any[] = [];
    
    // Try multiple selectors for products
    const selectors = [
      "[data-recommendation-id]",
      "[data-asin]",
      "div[data-item-index]",
      ".s-result-item[data-asin]",
    ];
    
    for (const selector of selectors) {
      const productElements = document.querySelectorAll<HTMLElement>(selector);
      
      productElements.forEach((element: HTMLElement) => {
        let asin: string | null = null;
        let url: string | null = null;
        let title: string | null = null;
        let priceCents: number | null = null;
        let currencyCode: string | null = null;
        let rating: number | null = null;
        let ratingCount: number | null = null;
        let images: string[] = [];
        
        // Try data-recommendation-id first
        const recommendationId = element.getAttribute("data-recommendation-id");
        if (recommendationId) {
          const asinMatch = recommendationId.match(/#([A-Z0-9]{10})#/i);
          if (asinMatch && asinMatch[1]) {
            asin = asinMatch[1].toUpperCase();
            url = `${window.location.origin}/dp/${asin}`;
          }
        }
        
        // Try data-asin attribute
        if (!asin) {
          const dataAsin = element.getAttribute("data-asin");
          if (dataAsin && dataAsin.length === 10) {
            asin = dataAsin.toUpperCase();
            url = `${window.location.origin}/dp/${asin}`;
          }
        }
        
        // Try finding links to product pages
        if (!url) {
          const productLink = element.querySelector<HTMLAnchorElement>("a[href*='/dp/']");
          if (productLink) {
            const href = productLink.getAttribute("href");
            if (href) {
              const match = href.match(/\/dp\/([A-Z0-9]{10})/i);
              if (match && match[1]) {
                asin = match[1].toUpperCase();
                url = `${window.location.origin}/dp/${asin}`;
              }
            }
          }
        }
        
        // Extract title
        const titleElement = element.querySelector("h2 a, .s-title a, a[href*='/dp/']");
        if (titleElement) {
          title = titleElement.textContent?.trim() || null;
        }
        
        // Extract price
        const priceElement = element.querySelector(".a-price .a-offscreen, .a-price-whole, [data-a-color='price']");
        if (priceElement) {
          const priceText = priceElement.textContent?.trim() || priceElement.getAttribute("aria-label") || "";
          const priceMatch = priceText.match(/([A-Z]{2,3})?\s*\$?([\d,]+(?:\.\d{1,2})?)/);
          if (priceMatch) {
            const [, currency, amount] = priceMatch;
            const numeric = Number(amount.replace(/,/g, ""));
            if (!isNaN(numeric)) {
              priceCents = Math.round(numeric * 100);
              currencyCode = currency || "USD";
            }
          }
        }
        
        // Extract rating
        const ratingElement = element.querySelector(".a-icon-alt, [aria-label*='stars']");
        if (ratingElement) {
          const ratingText = ratingElement.textContent || ratingElement.getAttribute("aria-label") || "";
          const ratingMatch = ratingText.match(/(\d+\.?\d*)\s*(?:out of|stars?)/i);
          if (ratingMatch) {
            rating = parseFloat(ratingMatch[1]);
          }
        }
        
        // Extract rating count
        const ratingCountElement = element.querySelector("a[href*='#customerReviews'], .a-size-base");
        if (ratingCountElement) {
          const ratingCountText = ratingCountElement.textContent?.trim() || "";
          const countMatch = ratingCountText.match(/([\d,]+)/);
          if (countMatch) {
            ratingCount = parseInt(countMatch[1].replace(/,/g, ""), 10);
          }
        }
        
        // Extract images
        const imageElements = element.querySelectorAll<HTMLImageElement>("img[src], img[data-src]");
        imageElements.forEach((img) => {
          const imgSrc = img.getAttribute("src") || img.getAttribute("data-src");
          if (imgSrc && imgSrc.includes("amazon.com") && !imgSrc.includes("pixel")) {
            try {
              const imgUrl = new URL(imgSrc, window.location.origin);
              if (!images.includes(imgUrl.toString())) {
                images.push(imgUrl.toString());
              }
            } catch {}
          }
        });
        
        if (asin && url && !extracted.find((p: any) => p.asin === asin)) {
          extracted.push({
            asin,
            url,
            title: title || "Unknown Product",
            pageNumber: pageNum,
            priceCents,
            currencyCode,
            rating,
            ratingCount,
            images,
          });
        }
      });
    }
    
    return extracted;
  }, pageNumber);
  
  logger.info({ pageNumber, productsFound: products.length }, "Extracted products from encore page");
  return products;
};

const extractProduct = async (page: Page, url: string, pageNumber: number): Promise<any> => {
  // Get title - prefer visible span over hidden input
  const titleElement = page.locator("#productTitle").first();
  const title = await titleElement.textContent();
  
  // If title is empty or just whitespace, try the hidden input as fallback
  const titleText = title?.trim();
  const finalTitle = titleText || await page.locator("input[name='productTitle']").getAttribute("value") || "";
  
  const asin =
    (await page.locator("#ASIN").getAttribute("value")) ??
    (await page.locator("[data-asin]").getAttribute("data-asin")) ??
    url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];

  const priceText =
    (await page.locator("#priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox").first().textContent()) ??
    (await page.locator('[data-a-color="pricetext"]').first().textContent());

  const ratingsText = await page.locator(".averageStarRating span, span#acrCustomerReviewText").first().textContent().catch(() => null);
  const ratingValue = await page.locator('span[data-hook="rating-out-of-text"]').textContent().catch(() => null);

  const images = await page.evaluate(() => {
    const found = new Set<string>();
    const addUrl = (value: string | null | undefined) => {
      if (!value) return;
      try {
        const url = new URL(value, window.location.origin);
        found.add(url.toString());
      } catch {}
    };

    document
      .querySelectorAll<HTMLImageElement>('#altImages img[src], img[data-old-hires], img[data-a-dynamic-image]')
      .forEach((img) => {
        const dynamic = img.getAttribute("data-a-dynamic-image");
        if (dynamic) {
          try {
            const parsed = JSON.parse(dynamic) as Record<string, unknown>;
            for (const key of Object.keys(parsed)) {
              addUrl(key);
            }
          } catch {}
        }
        addUrl(img.getAttribute("data-old-hires"));
        addUrl(img.getAttribute("src"));
      });

    return Array.from(found);
  });

  if (!title || !asin) {
    throw new Error("Unable to extract essential product fields");
  }

  const parsePrice = (rawPrice?: string | null): { priceCents: number | null; currencyCode: string | null } => {
    if (!rawPrice) {
      return { priceCents: null, currencyCode: null };
    }

    const match = rawPrice.match(/([A-Z]{2,3})?\s*\$?([\d,]+(?:\.\d{1,2})?)/);
    if (!match) {
      return { priceCents: null, currencyCode: null };
    }

    const [, currency, amount] = match;
    const numeric = Number(amount.replace(/,/g, ""));
    if (Number.isNaN(numeric)) {
      return { priceCents: null, currencyCode: currency ?? null };
    }

    return {
      priceCents: Math.round(numeric * 100),
      currencyCode: currency ?? "USD",
    };
  };

  const { priceCents, currencyCode } = parsePrice(priceText?.trim());
  const ratingCount = ratingsText ? Number(ratingsText.replace(/[^\d]/g, "")) : null;
  const rating = ratingValue ? Number(ratingValue.replace(/[^\d.]/g, "")) : null;

  return {
    asin: asin.trim(),
    url,
    title: finalTitle.trim(),
    pageNumber,
    images,
    priceCents,
    currencyCode,
    rating,
    ratingCount,
  };
};

const crawlProduct = async (job: Job<ProductJobData>): Promise<void> => {
  const { url, pageNumber, asin } = job.data;
  const jobId = job.id;
  const tabId = asin || `tab-${jobId}`;

  logger.info({ jobId, url, pageNumber, asin }, "Processing product job");

  let page: Page | null = null;

  try {
    // Get or create a page for this product (VNC browser tab)
    page = await getOrCreatePage(tabId);

    // Ensure we're logged in
    await ensureLoggedIn(page);

    // Navigate to product page
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // Extract product data
    const product = await extractProduct(page, url, pageNumber);

    // Store in database
    await upsertProduct(product);

    // Record success
    await recordCrawlEvent(
      {
        asin: product.asin,
        url: product.url,
        pageNumber: product.pageNumber,
      },
      "success"
    );

    logger.info({ jobId, asin: product.asin, title: product.title.substring(0, 50) }, "Product crawled and stored successfully");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg, jobId, url, pageNumber }, "Failed to crawl product");

    // Record failure
    await recordCrawlEvent(
      {
        asin: asin || null,
        url,
        pageNumber,
      },
      "failed",
      errorMsg
    );

    throw error;
  } finally {
    // Don't close the page - keep it for reuse (VNC browser tab)
    // The page will be reused for other products
  }
};

const calculatePageRangeForBatch = (batchStart: number, batchEnd: number): { startPage: number; endPage: number } => {
  // If worker ID and total workers are configured, distribute pages within the batch
  if (config.PRODUCT_WORKER_ID && config.PRODUCT_WORKER_TOTAL) {
    const workerId = config.PRODUCT_WORKER_ID;
    const totalWorkers = config.PRODUCT_WORKER_TOTAL;
    const batchSize = batchEnd - batchStart + 1;
    const pagesPerWorker = Math.ceil(batchSize / totalWorkers);
    const startPage = batchStart + (workerId - 1) * pagesPerWorker;
    const endPage = Math.min(batchStart + workerId * pagesPerWorker - 1, batchEnd);
    
    logger.info({ 
      workerId, 
      totalWorkers, 
      batchStart,
      batchEnd,
      startPage, 
      endPage, 
      pagesAssigned: endPage - startPage + 1
    }, "Worker assigned page range within current batch");
    
    return { startPage, endPage };
  }
  
  // If no worker configuration, process all pages in the batch
  return { startPage: batchStart, endPage: batchEnd };
};

// 503 error handling removed - product workers don't need to handle 503 errors

const findTabByPageNumber = async (targetContext: BrowserContext, pageNum: number): Promise<Page | null> => {
  try {
    const encoreUrl = `${config.AMAZON_VINE_ENCORE_URL}&page=${pageNum}`;
    const expectedUrlPattern = `page=${pageNum}`;
    
    // Get all pages in the context
    const allPages = targetContext.pages();
    
    // Find a page that matches the URL pattern
    for (const page of allPages) {
      if (page.isClosed()) continue;
      
      try {
        const url = page.url();
        if (url.includes(expectedUrlPattern) || url === encoreUrl) {
          // Verify the page is still valid
          if (!page.isClosed()) {
            return page;
          }
        }
      } catch (error) {
        // Page might be closed, skip it
        continue;
      }
    }
    
    return null;
  } catch (error) {
    logger.error({ error, pageNum }, "Error finding tab by page number");
    return null;
  }
};

const crawlAllPages = async (): Promise<void> => {
  try {
    const workerId = config.PRODUCT_WORKER_ID || 1;
    logger.info({ workerId }, "Starting to crawl assigned pages...");
    
    // Wait for tabs to be ready (opened by general worker) - but don't wait too long
    logger.info("Waiting for general worker to open tabs...");
    let tabsReady = false;
    for (let i = 0; i < 30; i++) { // Reduced to 30 seconds max wait
      const tabsReadyStr = await redisConnection.get(REDIS_KEY_TABS_READY);
      if (tabsReadyStr === "1") {
        tabsReady = true;
        break;
      }
      await delay(1000); // Wait 1 second before checking again
    }
    
    if (!tabsReady) {
      logger.warn("Tabs not ready after 30 seconds. Proceeding anyway...");
    } else {
      logger.info("Tabs are ready! Using existing tabs opened by general worker.");
    }
    
    // Get total pages from Redis (dynamically discovered by general worker)
    const totalPagesStr = await redisConnection.get(REDIS_KEY_TOTAL_PAGES);
    if (!totalPagesStr) {
      logger.warn("Total pages not found in Redis. Waiting for general worker to discover pages...");
      return;
    }
    
    const totalPages = parseInt(totalPagesStr, 10);
    if (isNaN(totalPages) || totalPages <= 0) {
      logger.error({ totalPagesStr }, "Invalid total pages value from Redis");
      return;
    }
    
    // Get pages assigned to this worker by general worker
    const pagesStr = await redisConnection.get(REDIS_KEY_WORKER_PAGES(workerId));
    
    if (!pagesStr) {
      logger.info({ workerId }, "No pages assigned yet. Waiting for general worker to assign pages...");
      return;
    }
    
    let pagesToProcess = JSON.parse(pagesStr) as number[];
    
    if (pagesToProcess.length === 0) {
      logger.info({ workerId }, "No pages assigned to this worker. Waiting for assignment...");
      return;
    }
    
    // Also get total products for logging
    const totalProductsStr = await redisConnection.get(REDIS_KEY_TOTAL_PRODUCTS);
    const totalProducts = totalProductsStr ? parseInt(totalProductsStr, 10) : null;
    
    logger.info({ 
      workerId,
      totalPages, 
      totalProducts,
      pagesToProcess: pagesToProcess.length,
      pages: pagesToProcess.slice(0, 10),
      note: "Processing pages assigned by general worker" 
    }, "Found assigned pages, starting crawl process...");
    
    // Ensure browser is initialized
    await getBrowser();
    
    // Get browser instance to access contexts
    const browserInstance = await getBrowser();
    let targetContext: BrowserContext;
    
    // Use existing context if available, otherwise get/create one
    if (context) {
      targetContext = context;
    } else {
      const contexts = browserInstance.contexts();
      if (contexts.length > 0) {
        targetContext = contexts[0];
      } else {
        logger.error("No browser context available. General worker should have opened tabs.");
        return;
      }
    }
  
    // Process assigned pages - find existing tabs instead of creating new ones
    let totalProductsCrawled = 0;
    
    logger.info({ workerId, pagesCount: pagesToProcess.length }, "Finding and processing existing tabs for assigned pages...");
    
    // Process pages sequentially - check for new assignments periodically
    while (pagesToProcess.length > 0) {
      // Check for reassignments from general worker (dynamic load balancing)
      const updatedPagesStr = await redisConnection.get(REDIS_KEY_WORKER_PAGES(workerId));
      if (updatedPagesStr) {
        const updatedPages = JSON.parse(updatedPagesStr) as number[];
        // Update our list with any new pages (general worker may have reassigned)
        if (updatedPages.length !== pagesToProcess.length || 
            JSON.stringify(updatedPages.sort()) !== JSON.stringify(pagesToProcess.sort())) {
          logger.info({ workerId, oldCount: pagesToProcess.length, newCount: updatedPages.length }, "Pages reassigned - updating work list");
          pagesToProcess = updatedPages;
        }
      }
      
      if (pagesToProcess.length === 0) {
        break; // No more pages to process
      }
      
      // Get next page to process
      const pageNum = pagesToProcess[0];
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount <= maxRetries) {
        try {
          // Find existing tab for this page number
          const tab = await findTabByPageNumber(targetContext, pageNum);
          
          if (!tab || tab.isClosed()) {
            logger.warn({ pageNum }, "Tab not found or closed for this page, skipping...");
            break;
          }
          
          logger.info({ pageNum, url: tab.url() }, "Found existing tab, extracting products...");
          
          // Extract all products from this page
          const products = await extractProductsFromPage(tab, pageNum);
        
        logger.info({ pageNum, productsFound: products.length }, "Extracted products from page");
        
        // Get existing products for this page number
        const existingProducts = await getProductsByPage(pageNum);
        const existingAsins = new Set(existingProducts.map(p => p.asin));
        const newAsins = new Set(products.map(p => p.asin));
        
        // Compare ASINs to see if products have changed
        const asinsChanged = 
          existingAsins.size !== newAsins.size ||
          !Array.from(newAsins).every(asin => existingAsins.has(asin));
        
        if (asinsChanged) {
          logger.info({ 
            pageNum, 
            existingCount: existingAsins.size, 
            newCount: newAsins.size
          }, "Products changed for this page - deleting old products");
          
          // Delete old products for this page
          const deletedCount = await deleteProductsByPageNumber(pageNum);
          logger.info({ pageNum, deletedCount }, "Deleted old products for page");
        } else {
          logger.info({ pageNum }, "Products unchanged for this page - skipping deletion");
        }
        
        // Store all new products directly from encore page
        logger.info({ pageNum, totalProducts: products.length }, "Storing products from encore page");
        for (let productIndex = 0; productIndex < products.length; productIndex++) {
          const product = products[productIndex];
          try {
            // Store in database (product data already extracted from encore page)
            await upsertProduct(product);
            
            // Record success
            await recordCrawlEvent(
              {
                asin: product.asin,
                url: product.url,
                pageNumber: product.pageNumber,
              },
              "success"
            );
            
            totalProductsCrawled++;
            
            // Log every 10 products to avoid too much logging
            if (productIndex % 10 === 0 || productIndex === products.length - 1) {
              logger.info({ 
                pageNum, 
                productIndex: productIndex + 1, 
                totalProducts: products.length,
                totalCrawled: totalProductsCrawled 
              }, "Storing products...");
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error({ 
              error: errorMsg,
              pageNum, 
              asin: product.asin,
              url: product.url 
            }, "Failed to store product - continuing with next product");
            
            // Record failure
            await recordCrawlEvent(
              {
                asin: product.asin,
                url: product.url,
                pageNumber: product.pageNumber,
              },
              "failed",
              errorMsg
            );
          }
        }
        
          logger.info({ pageNum, productsFound: products.length, totalCrawled: totalProductsCrawled }, "Completed crawling page");
          
          // Remove this page from assigned list and update Redis
          pagesToProcess.shift(); // Remove first page (the one we just processed)
          await redisConnection.set(REDIS_KEY_WORKER_PAGES(workerId), JSON.stringify(pagesToProcess));
          
          // Small delay between pages to avoid overwhelming the browser
          await delay(500);
          break; // Success, exit retry loop
        } catch (error: any) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          
          // Retry on errors (but not specifically for 503)
          if (retryCount < maxRetries) {
            logger.warn({ error: errorMsg, pageNum, retryCount }, "Error processing page, retrying...");
            await delay(5000); // Wait 5 seconds before retry
            retryCount++;
            continue;
          } else {
            logger.error({ error: errorMsg, pageNum }, "Failed to process page after retries");
            break;
          }
        }
      }
    }
  
  logger.info({ totalProductsCrawled, workerId, pagesProcessed: pagesToProcess.length === 0 }, "✅ Completed all assigned pages");
  
  // Mark worker as complete (no more pages assigned)
  if (pagesToProcess.length === 0) {
    await redisConnection.set(REDIS_KEY_WORKER_COMPLETE(workerId), "1");
    logger.info({ workerId }, "Worker completed all assigned pages - waiting for more or batch completion");
  }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error({ 
      error: errorMessage, 
      stack: errorStack, 
      rawError: error,
      errorType: error?.constructor?.name 
    }, "Error in crawlAllPages");
    throw error; // Re-throw so it can be handled by caller
  }
};

const checkAndCrawlIfNeeded = async (): Promise<void> => {
  try {
    const workerId = config.PRODUCT_WORKER_ID || 1;
    
    // Check for assigned pages directly (not just trigger)
    const pagesStr = await redisConnection.get(REDIS_KEY_WORKER_PAGES(workerId));
    
    if (pagesStr) {
      const pages = JSON.parse(pagesStr) as number[];
      if (pages.length > 0) {
        logger.info({ workerId, pagesCount: pages.length }, "Found assigned pages - starting crawl process");
        await crawlAllPages();
        return;
      }
    }
    
    // Also check for trigger (backward compatibility)
    const trigger = await redisConnection.get(REDIS_KEY_CRAWL_TRIGGER);
    if (trigger === "1") {
      logger.info("Crawl trigger detected - checking for assigned pages");
      
      // Clear the trigger
      await redisConnection.del(REDIS_KEY_CRAWL_TRIGGER);
      
      // Start crawling (will check for assigned pages inside)
      await crawlAllPages();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error({ error: errorMessage, stack: errorStack, rawError: error }, "Error checking for crawl triggers");
    throw error; // Re-throw to be caught by polling handler
  }
};

const main = async (): Promise<void> => {
  logger.info("Product worker starting...");

  try {
    // Initialize browser
    await getBrowser();
    logger.info("Browser initialized");
    
    // Check if we should crawl immediately (on startup or if trigger is set)
    await checkAndCrawlIfNeeded();
    
    // Set up continuous polling to check for assigned pages every 2 seconds
    // This ensures workers pick up work immediately when assigned
    const POLL_INTERVAL = 2000; // 2 seconds - check frequently for new assignments
    const HEARTBEAT_INTERVAL = 10000; // 10 seconds - send heartbeat
    let isProcessing = false; // Prevent concurrent processing
    const workerId = config.PRODUCT_WORKER_ID || 1;
    
    // Send heartbeat to Redis so general worker knows this worker is alive
    const sendHeartbeat = async () => {
      try {
        const now = Date.now();
        await redisConnection.set(REDIS_KEY_WORKER_HEARTBEAT(workerId), now.toString());
      } catch (error) {
        // Don't log heartbeat errors - they're not critical
      }
    };
    
    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval
    const heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    
    const pollForWork = async () => {
      try {
        // Send heartbeat periodically
        await sendHeartbeat();
        
        // Only check if not already processing
        if (!isProcessing) {
          await checkAndCrawlIfNeeded();
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, "Error in work check - will retry on next poll");
        // Don't throw - continue polling even if there's an error
        isProcessing = false; // Reset flag on error
      }
      
      // Schedule next poll
      setTimeout(pollForWork, POLL_INTERVAL);
    };
    
    // Start polling immediately
    setTimeout(pollForWork, 1000); // Start after 1 second
    logger.info({ interval: POLL_INTERVAL, heartbeatInterval: HEARTBEAT_INTERVAL, workerId }, "Started continuous polling for assigned pages");

    // NOTE: Legacy job worker disabled - we now extract directly from encore page listings
    // without navigating to individual product detail pages
    // const worker = createWorker(crawlProduct);
    // worker.on("completed", (job) => {
    //   logger.info({ jobId: job.id }, "Legacy job completed");
    // });
    // worker.on("failed", (job, err) => {
    //   logger.error({ jobId: job?.id, error: err.message }, "Legacy job failed");
    // });
    
    logger.info("Product worker ready - will extract from encore page listings only (no product detail page navigation)");

    const shutdown = async (): Promise<void> => {
      logger.info("Product worker shutting down");
      
      // Clear heartbeat on shutdown
      try {
        await redisConnection.del(REDIS_KEY_WORKER_HEARTBEAT(workerId));
      } catch {
        // Ignore errors
      }
      
      // Clear worker pages assignment
      try {
        await redisConnection.del(REDIS_KEY_WORKER_PAGES(workerId));
      } catch {
        // Ignore errors
      }
      
      // Clear heartbeat interval
      if (typeof heartbeatInterval !== 'undefined') {
        clearInterval(heartbeatInterval);
      }
      
      // await worker.close(); // Legacy worker disabled
      await closeQueueResources();

      // Close all active pages
      for (const [tabId, page] of activePages.entries()) {
        try {
          if (!page.isClosed()) {
            await page.close();
          }
        } catch {
          // Ignore errors
        }
        activePages.delete(tabId);
      }

      if (browser) {
        await browser.close();
      }

      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    logger.info("Product worker started and ready");
  } catch (error) {
    logger.error({ error }, "Product worker failed to start");
    process.exit(1);
  }
};

main().catch((error) => {
  logger.error({ error }, "Product worker crashed");
  process.exit(1);
});

