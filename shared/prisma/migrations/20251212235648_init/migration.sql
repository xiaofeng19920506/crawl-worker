-- CreateTable
CREATE TABLE `products` (
    `asin` VARCHAR(10) NOT NULL,
    `url` TEXT NOT NULL,
    `title` TEXT NOT NULL,
    `page_number` INTEGER NOT NULL,
    `images` JSON NOT NULL,
    `price_cents` INTEGER NULL,
    `currency_code` VARCHAR(3) NULL,
    `rating` DECIMAL(3, 2) NULL,
    `rating_count` INTEGER NULL,
    `brand` TEXT NULL,
    `description` TEXT NULL,
    `category` TEXT NULL,
    `availability` VARCHAR(100) NULL,
    `prime_eligible` BOOLEAN NULL DEFAULT false,
    `discount` VARCHAR(50) NULL,
    `original_price` INTEGER NULL,
    `vine_note` TEXT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `products_page_number_idx`(`page_number`),
    INDEX `products_created_at_idx`(`created_at`),
    INDEX `products_updated_at_idx`(`updated_at`),
    INDEX `products_asin_idx`(`asin`),
    PRIMARY KEY (`asin`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_crawl_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `asin` VARCHAR(10) NULL,
    `url` TEXT NOT NULL,
    `page_number` INTEGER NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `error` TEXT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `product_crawl_events_asin_idx`(`asin`),
    INDEX `product_crawl_events_status_idx`(`status`),
    INDEX `product_crawl_events_page_number_idx`(`page_number`),
    INDEX `product_crawl_events_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `crawl_metadata` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `total_pages` INTEGER NOT NULL,
    `total_products` INTEGER NOT NULL,
    `last_updated` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `product_crawl_events` ADD CONSTRAINT `product_crawl_events_asin_fkey` FOREIGN KEY (`asin`) REFERENCES `products`(`asin`) ON DELETE SET NULL ON UPDATE CASCADE;
