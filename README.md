# Amazon Vine Crawler

Amazon Vine crawler with general worker, product workers, and API server.

## Quick Start

1. Install dependencies: `npm install`
2. Copy `.env.template` to `.env` and configure
3. Start services: `docker compose up -d`
4. Run migrations: `cd shared && npx prisma migrate dev`
5. Start workers: `npm run start:general-worker` and `npm run start:product-worker`

