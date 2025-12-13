import express from "express";
import { config, logger, initDb, getProductByAsin, getProductsByPage, getAllProducts, getTotalProductCount } from "shared";

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS middleware for extension
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "vine-api" });
});

// Get all products (paginated) - for extension
app.get("/api/products", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 100;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const products = await getAllProducts(limit, offset);
    const total = await getTotalProductCount();

    res.json({
      success: true,
      products,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg }, "Failed to get products via API");
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// Get product by ASIN - for extension
app.get("/api/products/:asin", async (req, res) => {
  try {
    const { asin } = req.params;
    const product = await getProductByAsin(asin);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    res.json({ success: true, product });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg, asin: req.params.asin }, "Failed to get product via API");
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// Get products by page number - for extension
app.get("/api/products/page/:pageNumber", async (req, res) => {
  try {
    const pageNumber = parseInt(req.params.pageNumber, 10);
    if (isNaN(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ success: false, error: "Invalid page number" });
    }
    const products = await getProductsByPage(pageNumber);
    res.json({ success: true, products, count: products.length });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg, pageNumber: req.params.pageNumber }, "Failed to get products by page via API");
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// Get statistics - for extension
app.get("/api/stats", async (req, res) => {
  try {
    const totalProducts = await getTotalProductCount();
    res.json({
      success: true,
      stats: {
        totalProducts,
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg }, "Failed to get stats via API");
    res.status(500).json({ success: false, error: errorMsg });
  }
});

const main = async (): Promise<void> => {
  try {
    // Initialize database connection
    await initDb();
    logger.info("Database initialized for API");

    const port = config.API_PORT;
    app.listen(port, () => {
      logger.info({ port }, "API server started");
    });
  } catch (error) {
    logger.error({ error }, "Failed to start API server");
    process.exit(1);
  }
};

main().catch((error) => {
  logger.error({ error }, "API crashed");
  process.exit(1);
});

