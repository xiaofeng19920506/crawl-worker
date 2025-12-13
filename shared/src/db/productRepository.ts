import { z } from "zod";
import { getDb } from "./client.js";
import { logger } from "../logger.js";

export const productSchema = z.object({
  asin: z.string(),
  url: z.string(),
  title: z.string(),
  pageNumber: z.number().int().positive(),
  images: z.array(z.string()).default([]),
  priceCents: z.number().nullable(),
  currencyCode: z.string().nullable(),
  rating: z.number().nullable(),
  ratingCount: z.number().nullable(),
  brand: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  availability: z.string().nullable().optional(),
  primeEligible: z.boolean().nullable().optional(),
  discount: z.string().nullable().optional(),
  originalPrice: z.number().nullable().optional(),
  vineNote: z.string().nullable().optional(),
});

export type ProductRecord = z.infer<typeof productSchema>;

export const upsertProduct = async (product: ProductRecord): Promise<void> => {
  const db = getDb();

  await db.product.upsert({
    where: { asin: product.asin },
    create: {
      asin: product.asin,
      url: product.url,
      title: product.title,
      pageNumber: product.pageNumber,
      images: product.images as any,
      priceCents: product.priceCents,
      currencyCode: product.currencyCode,
      rating: product.rating ? product.rating : null,
      ratingCount: product.ratingCount,
      brand: product.brand ?? null,
      description: product.description ?? null,
      category: product.category ?? null,
      availability: product.availability ?? null,
      primeEligible: product.primeEligible ?? null,
      discount: product.discount ?? null,
      originalPrice: product.originalPrice ?? null,
      vineNote: product.vineNote ?? null,
    },
    update: {
      url: product.url,
      title: product.title,
      pageNumber: product.pageNumber,
      images: product.images as any,
      priceCents: product.priceCents,
      currencyCode: product.currencyCode,
      rating: product.rating ? product.rating : null,
      ratingCount: product.ratingCount,
      brand: product.brand ?? null,
      description: product.description ?? null,
      category: product.category ?? null,
      availability: product.availability ?? null,
      primeEligible: product.primeEligible ?? null,
      discount: product.discount ?? null,
      originalPrice: product.originalPrice ?? null,
      vineNote: product.vineNote ?? null,
      updatedAt: new Date(),
    },
  });
};

export const upsertProductsBatch = async (
  products: ProductRecord[]
): Promise<{ created: number; updated: number }> => {
  if (products.length === 0) {
    return { created: 0, updated: 0 };
  }

  const db = getDb();
  let updated = 0;

  const BATCH_SIZE = 100;
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);

    try {
      await db.$transaction(
        async (tx) => {
          for (const product of batch) {
            try {
              await tx.product.upsert({
                where: { asin: product.asin },
                create: {
                  asin: product.asin,
                  url: product.url,
                  title: product.title,
                  pageNumber: product.pageNumber,
                  images: product.images as any,
                  priceCents: product.priceCents,
                  currencyCode: product.currencyCode,
                  rating: product.rating ? product.rating : null,
                  ratingCount: product.ratingCount,
                  brand: product.brand ?? null,
                  description: product.description ?? null,
                  category: product.category ?? null,
                  availability: product.availability ?? null,
                  primeEligible: product.primeEligible ?? null,
                  discount: product.discount ?? null,
                  originalPrice: product.originalPrice ?? null,
                  vineNote: product.vineNote ?? null,
                },
                update: {
                  url: product.url,
                  title: product.title,
                  pageNumber: product.pageNumber,
                  images: product.images as any,
                  priceCents: product.priceCents,
                  currencyCode: product.currencyCode,
                  rating: product.rating ? product.rating : null,
                  ratingCount: product.ratingCount,
                  brand: product.brand ?? null,
                  description: product.description ?? null,
                  category: product.category ?? null,
                  availability: product.availability ?? null,
                  primeEligible: product.primeEligible ?? null,
                  discount: product.discount ?? null,
                  originalPrice: product.originalPrice ?? null,
                  vineNote: product.vineNote ?? null,
                  updatedAt: new Date(),
                },
              });
              updated++;
            } catch (error) {
              logger.warn({ error, asin: product.asin }, "Failed to upsert product in batch");
            }
          }
        },
        {
          timeout: 30000,
        }
      );
    } catch (error) {
      logger.warn({ error, batchSize: batch.length }, "Batch transaction failed, falling back to individual upserts");
      for (const product of batch) {
        try {
          await upsertProduct(product);
          updated++;
        } catch {
          // Ignore individual failures
        }
      }
    }
  }

  return { created: 0, updated };
};

export const getProductByAsin = async (asin: string): Promise<ProductRecord | null> => {
  const db = getDb();
  const product = await db.product.findUnique({
    where: { asin },
  });

  if (!product) {
    return null;
  }

  return {
    asin: product.asin,
    url: product.url,
    title: product.title,
    pageNumber: product.pageNumber,
    images: Array.isArray(product.images) ? product.images : typeof product.images === "string" ? JSON.parse(product.images) : [],
    priceCents: product.priceCents,
    currencyCode: product.currencyCode,
    rating: product.rating ? Number(product.rating) : null,
    ratingCount: product.ratingCount,
    brand: product.brand ?? undefined,
    description: product.description ?? undefined,
    category: product.category ?? undefined,
    availability: product.availability ?? undefined,
    primeEligible: product.primeEligible ?? undefined,
    discount: product.discount ?? undefined,
    originalPrice: product.originalPrice ?? undefined,
    vineNote: product.vineNote ?? undefined,
  };
};

export const getProductsByPage = async (pageNumber: number): Promise<ProductRecord[]> => {
  const db = getDb();
  const products = await db.product.findMany({
    where: { pageNumber },
  });

  return products.map((p) => ({
    asin: p.asin,
    url: p.url,
    title: p.title,
    pageNumber: p.pageNumber,
    images: Array.isArray(p.images) ? p.images : typeof p.images === "string" ? JSON.parse(p.images) : [],
    priceCents: p.priceCents,
    currencyCode: p.currencyCode,
    rating: p.rating ? Number(p.rating) : null,
    ratingCount: p.ratingCount,
    brand: p.brand ?? undefined,
    description: p.description ?? undefined,
    category: p.category ?? undefined,
    availability: p.availability ?? undefined,
    primeEligible: p.primeEligible ?? undefined,
    discount: p.discount ?? undefined,
    originalPrice: p.originalPrice ?? undefined,
    vineNote: p.vineNote ?? undefined,
  }));
};

export const getAllProducts = async (limit: number = 100, offset: number = 0): Promise<ProductRecord[]> => {
  const db = getDb();
  const products = await db.product.findMany({
    take: limit,
    skip: offset,
    orderBy: { updatedAt: "desc" },
  });

  return products.map((p) => ({
    asin: p.asin,
    url: p.url,
    title: p.title,
    pageNumber: p.pageNumber,
    images: Array.isArray(p.images) ? p.images : typeof p.images === "string" ? JSON.parse(p.images) : [],
    priceCents: p.priceCents,
    currencyCode: p.currencyCode,
    rating: p.rating ? Number(p.rating) : null,
    ratingCount: p.ratingCount,
    brand: p.brand ?? undefined,
    description: p.description ?? undefined,
    category: p.category ?? undefined,
    availability: p.availability ?? undefined,
    primeEligible: p.primeEligible ?? undefined,
    discount: p.discount ?? undefined,
    originalPrice: p.originalPrice ?? undefined,
    vineNote: p.vineNote ?? undefined,
  }));
};

export const getTotalProductCount = async (): Promise<number> => {
  const db = getDb();
  return await db.product.count();
};

export const deleteProductsByPageNumber = async (pageNumber: number): Promise<number> => {
  const db = getDb();
  const result = await db.product.deleteMany({
    where: { pageNumber },
  });
  return result.count;
};

type CrawlStatus = "success" | "failed";

export const recordCrawlEvent = async (
  payload: {
    asin: string | null;
    url: string;
    pageNumber: number;
  },
  status: CrawlStatus,
  error?: string
): Promise<void> => {
  const db = getDb();

  // If asin is provided, ensure the product exists (for foreign key constraint)
  if (payload.asin) {
    // Check if product exists, if not create a minimal placeholder
    const existingProduct = await db.product.findUnique({
      where: { asin: payload.asin },
    });

    if (!existingProduct) {
      // Create a minimal product record to satisfy foreign key constraint
      await db.product.upsert({
        where: { asin: payload.asin },
        create: {
          asin: payload.asin,
          url: payload.url,
          title: "Pending crawl", // Will be updated when product is crawled
          pageNumber: payload.pageNumber,
          images: [],
        },
        update: {}, // Don't update if it exists
      });
    }
  }

  await db.productCrawlEvent.create({
    data: {
      asin: payload.asin,
      url: payload.url,
      pageNumber: payload.pageNumber,
      status: status,
      error: error ?? null,
    },
  });
};

