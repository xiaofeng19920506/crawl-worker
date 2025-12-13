# Manager Worker

Standalone manager worker that coordinates general workers across multiple servers.

## Overview

The manager worker is a lightweight, standalone service that:
- Detects active general workers via Redis heartbeats
- Distributes page ranges evenly among active general workers
- Automatically reassigns work when workers complete or new workers join
- Requires only Redis connection - no other dependencies

## Requirements

- Node.js >= 18.18.0
- Access to Redis instance (shared with general workers)
- No browser or local file dependencies

## Configuration

Set these environment variables:

```env
REDIS_URL=redis://localhost:6379
```

Optional:
```env
LOG_LEVEL=info  # debug, info, warn, error
```

## Running

### From workspace root:
```bash
npm run start:manager-worker
```

### Standalone (on any server):
```bash
cd manager-worker
npm install
npm start
```

### With environment variables:
```bash
REDIS_URL=redis://your-redis-server:6379 npm run start:manager-worker
```

## How It Works

1. **Worker Detection**: Polls Redis every 5 seconds to detect general workers with active heartbeats (within last 60 seconds)

2. **Page Distribution**: When total pages are discovered (by general workers), distributes pages evenly:
   - Worker 1: Pages 1-150
   - Worker 2: Pages 151-300
   - Worker 3: Pages 301-450
   - etc.

3. **Dynamic Reassignment**: Automatically reassigns work when:
   - New workers join (detected via new heartbeats)
   - Workers complete their assigned range
   - Total pages change

## Deployment

The manager worker can run on any server that has:
- Network access to Redis
- Node.js installed

**Example deployment on separate server:**
```bash
# On manager server
git clone <repo>
cd vine/manager-worker
npm install
REDIS_URL=redis://your-redis-server:6379 npm start
```

## Architecture

```
Manager Worker (1 instance, any server)
    ↓ (Redis coordination)
General Workers (multiple, different servers)
    ↓ (opens tabs & distributes)
Product Workers (multiple)
```

## Notes

- Only **one** manager worker should run at a time
- Manager worker is stateless - all state is in Redis
- If manager worker crashes, restart it - it will resume coordination
- General workers can be added/removed dynamically without restarting manager

