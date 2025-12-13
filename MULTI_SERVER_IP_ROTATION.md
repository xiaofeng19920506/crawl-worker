# Multi-Server Setup with IP Rotation Guide

## Overview

This guide covers setting up the Vine Crawler across multiple servers with IP rotation to avoid rate limiting and IP bans.

## Architecture Options

### Option 1: Different IPs per Server (Simplest)
Each server has a different IP address (different VPS providers, different datacenters, or VPN per server).

```
┌─────────────────────────────────┐
│  Server 1 (IP: 1.2.3.4)        │
│  - Manager Worker                │
│  - API Server                     │
│  - Redis/MySQL                    │
└─────────────────────────────────┘
              ↓ (Redis)
┌─────────────────────────────────┐
│  Server 2 (IP: 5.6.7.8)        │
│  - General Worker (ID: 1)        │
│  - Product Workers (ID: 1, 2)   │
└─────────────────────────────────┘
              ↓ (Redis)
┌─────────────────────────────────┐
│  Server 3 (IP: 9.10.11.12)     │
│  - General Worker (ID: 2)        │
│  - Product Workers (ID: 3, 4)   │
└─────────────────────────────────┘
```

**Pros:**
- Simplest setup - no code changes needed
- Each server naturally has different IP
- No proxy costs

**Cons:**
- Limited to number of servers you have
- Can't rotate IPs on same server

---

### Option 2: Proxy Rotation per Server (Recommended)
Each server uses a rotating proxy service (e.g., ScraperAPI, Bright Data, Oxylabs).

```
┌─────────────────────────────────┐
│  Server 1 (Main)                │
│  - Manager Worker                │
│  - API Server                     │
└─────────────────────────────────┘
              ↓ (Redis)
┌─────────────────────────────────┐
│  Server 2                       │
│  - General Worker (ID: 1)        │
│  - Product Workers (ID: 1, 2)   │
│  - Proxy: proxy1.example.com    │
│    (rotates IPs automatically)   │
└─────────────────────────────────┘
              ↓ (Redis)
┌─────────────────────────────────┐
│  Server 3                       │
│  - General Worker (ID: 2)        │
│  - Product Workers (ID: 3, 4)   │
│  - Proxy: proxy2.example.com    │
│    (rotates IPs automatically)   │
└─────────────────────────────────┘
```

**Pros:**
- Automatic IP rotation
- Can use residential proxies
- Scales well
- Each server can have different proxy pool

**Cons:**
- Proxy service costs ($50-500/month depending on traffic)
- Need to integrate proxy support

---

### Option 3: VPN Rotation per Server
Each server uses a VPN service that can rotate IPs (e.g., NordVPN, ExpressVPN with API).

```
┌─────────────────────────────────┐
│  Server 1 (Main)                │
│  - Manager Worker                │
│  - API Server                     │
└─────────────────────────────────┘
              ↓ (Redis)
┌─────────────────────────────────┐
│  Server 2                       │
│  - VPN Client (rotates IP)       │
│  - General Worker (ID: 1)        │
│  - Product Workers (ID: 1, 2)   │
└─────────────────────────────────┘
```

**Pros:**
- Can rotate IPs programmatically
- Good for residential IPs

**Cons:**
- More complex setup
- VPN API integration needed
- Slower than direct connection

---

## Implementation: Proxy Support

### Step 1: Add Proxy Configuration

Add to `shared/src/config.ts`:

```typescript
// Proxy configuration
USE_PROXY: z
  .string()
  .transform((value) => value.toLowerCase() === "true" || value === "1")
  .or(z.boolean())
  .default(false),
PROXY_SERVER: z.string().optional().describe("Proxy server URL (e.g., http://proxy.example.com:8080)"),
PROXY_USERNAME: z.string().optional(),
PROXY_PASSWORD: z.string().optional(),
PROXY_ROTATE_AFTER_TABS: z.coerce.number().int().positive().optional().describe("Rotate proxy after N tabs"),
```

### Step 2: Update Browser Launch Options

Update `general-worker/src/index.ts` and `product-worker/src/index.ts`:

```typescript
const getBrowser = async (): Promise<Browser> => {
  // ... existing code ...
  
  const launchOptions: any = {
    headless: config.PLAYWRIGHT_HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
    viewport: { width: 1920, height: 1080 },
  };
  
  // Add proxy configuration
  if (config.USE_PROXY && config.PROXY_SERVER) {
    launchOptions.proxy = {
      server: config.PROXY_SERVER,
    };
    
    if (config.PROXY_USERNAME && config.PROXY_PASSWORD) {
      launchOptions.proxy.username = config.PROXY_USERNAME;
      launchOptions.proxy.password = config.PROXY_PASSWORD;
    }
    
    logger.info({ proxy: config.PROXY_SERVER }, "Using proxy for browser");
  }
  
  // ... rest of code ...
};
```

### Step 3: Update .env Template

Add to `env.template`:

```env
# Proxy Configuration (for IP rotation)
USE_PROXY=false
PROXY_SERVER=http://proxy.example.com:8080
PROXY_USERNAME=your-username
PROXY_PASSWORD=your-password
PROXY_ROTATE_AFTER_TABS=100
```

---

## Setup Instructions

### Server 1: All-in-One Server (Manager + API + Workers)

**Yes, you can run everything on one server!** This is perfect for:
- Starting out or testing
- Lower cost (only one server)
- Simpler setup

**Considerations:**
- **Resource Usage:** Chrome browsers use significant RAM (2-4GB per browser instance)
- **IP Rotation:** All workers will use the same IP unless you use proxies
- **Scaling:** Can add more servers later if needed

1. **Install dependencies:**
```bash
git clone <repo>
cd vine
npm install
```

2. **Install Chrome:**
```bash
# Ubuntu/Debian
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'
sudo apt-get update
sudo apt-get install -y google-chrome-stable

# Install Playwright browsers
npx playwright install chromium
```

3. **Create `.env` file:**
```env
# Database
DATABASE_URL=mysql://user:password@localhost:3307/vine

# Redis
REDIS_URL=redis://localhost:6379

# API
API_PORT=3000

# Worker IDs (for Server 1)
GENERAL_WORKER_ID=1
PRODUCT_WORKER_ID=1

# Chrome CDP
PLAYWRIGHT_CDP_ENDPOINT=http://localhost:9222

# Proxy Configuration (optional - for IP rotation)
# USE_PROXY=true
# PROXY_SERVER=http://proxy.example.com:8080
# PROXY_USERNAME=your-username
# PROXY_PASSWORD=your-password

# Logging
LOG_LEVEL=info
```

4. **Start Chrome with remote debugging:**
```bash
# Kill existing Chrome
pkill chrome

# Start Chrome with remote debugging
google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage &

# Or create a startup script
cat > /usr/local/bin/start-chrome-debug.sh << 'EOF'
#!/bin/bash
pkill chrome
google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage &
EOF

chmod +x /usr/local/bin/start-chrome-debug.sh
```

5. **Start all services with PM2:**
```bash
# Start Manager Worker
pm2 start npm --name "manager" -- run start:manager-worker

# Start API
pm2 start npm --name "api" -- run start:api

# Start General Worker
GENERAL_WORKER_ID=1 pm2 start npm --name "general-1" -- run start:general-worker

# Start Product Workers (you can run multiple)
PRODUCT_WORKER_ID=1 pm2 start npm --name "product-1" -- run start:product-worker
PRODUCT_WORKER_ID=2 pm2 start npm --name "product-2" -- run start:product-worker

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Follow the command it outputs
```

6. **Monitor services:**
```bash
pm2 status
pm2 logs
pm2 monit
```

**Architecture:**
```
┌─────────────────────────────────┐
│  Server 1 (All-in-One)         │
│  - Manager Worker                │
│  - API Server                     │
│  - General Worker (ID: 1)        │
│  - Product Workers (ID: 1, 2)   │
│  - Chrome Browser (CDP)          │
│  - Redis/MySQL                    │
└─────────────────────────────────┘
```

**Resource Requirements:**
- **RAM:** 4-8GB minimum (Chrome uses 2-4GB per instance)
- **CPU:** 2-4 cores recommended
- **Disk:** 20GB+ for browser data and logs

---

### Server 1: Main Server (Manager + API Only)

If you prefer to keep workers separate, you can run only Manager + API on Server 1:

1. **Install dependencies:**
```bash
git clone <repo>
cd vine
npm install
```

2. **Create `.env` file:**
```env
# Database
DATABASE_URL=mysql://user:password@localhost:3307/vine

# Redis
REDIS_URL=redis://localhost:6379

# API
API_PORT=3000

# Logging
LOG_LEVEL=info

# No proxy needed for manager/API
```

3. **Start services:**
```bash
pm2 start npm --name "manager" -- run start:manager-worker
pm2 start npm --name "api" -- run start:api
pm2 save
```

---

### Server 2: Worker Server #1

1. **Install dependencies:**
```bash
git clone <repo>
cd vine
npm install
```

2. **Install Chrome:**
```bash
# Ubuntu/Debian
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'
sudo apt-get update
sudo apt-get install -y google-chrome-stable
```

3. **Create `.env` file:**
```env
# Redis (connect to Server 1)
REDIS_URL=redis://server1-ip:6379

# Database (connect to Server 1)
DATABASE_URL=mysql://user:password@server1-ip:3307/vine

# Worker IDs
GENERAL_WORKER_ID=1
PRODUCT_WORKER_ID=1

# Chrome CDP
PLAYWRIGHT_CDP_ENDPOINT=http://localhost:9222

# Proxy Configuration (Option 2: Proxy Rotation)
USE_PROXY=true
PROXY_SERVER=http://proxy1.example.com:8080
PROXY_USERNAME=your-username
PROXY_PASSWORD=your-password

# OR for Option 1 (Different IPs per Server), just omit proxy settings
# Each server will use its own IP

# Logging
LOG_LEVEL=info
```

4. **Start Chrome with remote debugging:**
```bash
google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage &
```

5. **Start workers:**
```bash
GENERAL_WORKER_ID=1 pm2 start npm --name "general-1" -- run start:general-worker
PRODUCT_WORKER_ID=1 pm2 start npm --name "product-1" -- run start:product-worker
PRODUCT_WORKER_ID=2 pm2 start npm --name "product-2" -- run start:product-worker
pm2 save
```

---

### Server 3: Worker Server #2

Same as Server 2, but with different worker IDs and proxy:

```env
# Different worker IDs
GENERAL_WORKER_ID=2
PRODUCT_WORKER_ID=3

# Different proxy (if using Option 2)
PROXY_SERVER=http://proxy2.example.com:8080
```

---

## Proxy Service Recommendations

### 1. ScraperAPI
- **URL:** https://www.scraperapi.com
- **Cost:** $49-499/month
- **Features:** Automatic IP rotation, CAPTCHA solving, residential IPs
- **Setup:** Use their API endpoint as proxy

### 2. Bright Data (formerly Luminati)
- **URL:** https://brightdata.com
- **Cost:** $500+/month
- **Features:** Residential IPs, datacenter IPs, mobile IPs
- **Setup:** Configure proxy credentials

### 3. Oxylabs
- **URL:** https://oxylabs.io
- **Cost:** $300+/month
- **Features:** Residential and datacenter proxies
- **Setup:** Configure proxy credentials

### 4. Smartproxy
- **URL:** https://smartproxy.com
- **Cost:** $75+/month
- **Features:** Residential IPs, good for Amazon
- **Setup:** Configure proxy credentials

---

## VPN Rotation Setup (Option 3)

If using VPN rotation instead of proxies:

### 1. Install VPN Client
```bash
# For NordVPN (example)
wget -q -O - https://repo.nordvpn.com/gpg/nordvpn_public.asc | sudo apt-key add -
sudo sh -c 'echo "deb https://repo.nordvpn.com/deb/nordvpn/debian stable main" >> /etc/apt/sources.list.d/nordvpn.list'
sudo apt-get update
sudo apt-get install nordvpn
```

### 2. Create VPN Rotation Script
```bash
#!/bin/bash
# /usr/local/bin/rotate-vpn.sh

# Disconnect current VPN
nordvpn disconnect

# Wait a bit
sleep 5

# Connect to random server
nordvpn connect

# Log new IP
echo "New IP: $(curl -s ifconfig.me)" >> /var/log/vpn-rotation.log
```

### 3. Schedule Rotation
```bash
# Rotate every hour
crontab -e
# Add:
0 * * * * /usr/local/bin/rotate-vpn.sh
```

---

## Testing IP Rotation

### Check Current IP
```bash
# On each server, check IP
curl ifconfig.me
curl ipinfo.io/ip
```

### Verify Proxy is Working
```bash
# Test proxy connection
curl -x http://proxy.example.com:8080 http://ifconfig.me
```

### Monitor IP Changes
```bash
# Watch IP changes in logs
tail -f /var/log/vine-worker.log | grep "IP\|proxy"
```

---

## Round-Robin IP Rotation

### How It Works

When `ENABLE_ROUND_ROBIN_ROTATION=true`, the manager assigns work in batches, rotating through servers:

```
Server 1: Pages 1-50   → Process
Server 2: Pages 51-100  → Process  
Server 3: Pages 101-150 → Process
Server 1: Pages 151-200 → Process (cycles back!)
Server 2: Pages 201-250 → Process
...
```

### Configuration

Add to `.env` on Server 1 (Manager):

```env
# Enable round-robin rotation
ENABLE_ROUND_ROBIN_ROTATION=true
ROTATION_BATCH_SIZE=50  # Pages per rotation cycle
```

### Benefits

- **Natural IP Rotation:** Each server processes work sequentially
- **Load Distribution:** Work is evenly distributed over time
- **Automatic Cycling:** When Server 3 finishes, automatically goes to Server 1
- **No Manual Intervention:** Manager handles rotation automatically

### Example Flow

1. **Initial Assignment:**
   - Server 1 (General Worker ID: 1) gets pages 1-50
   - Server 1 processes batch

2. **After Server 1 Completes:**
   - Server 2 (General Worker ID: 2) gets pages 51-100
   - Server 2 processes batch

3. **After Server 2 Completes:**
   - Server 3 (General Worker ID: 3) gets pages 101-150
   - Server 3 processes batch

4. **Cycles Back:**
   - Server 1 gets pages 151-200 (back to Server 1!)
   - Continues rotating...

### Tuning

- **ROTATION_BATCH_SIZE:** Number of pages per rotation
  - Smaller (25-50): More frequent IP changes, slower overall
  - Larger (100-200): Less frequent IP changes, faster overall
  - Recommended: 50-100 pages per batch

---

## Best Practices

### 1. Rate Limiting
- Keep delays between requests (already configured)
- Don't crawl too fast even with IP rotation
- Respect Amazon's rate limits

### 2. User-Agent Rotation
- Rotate User-Agents to look more human
- Use realistic browser User-Agents

### 3. Cookie Management
- Shared cookies via Redis (already implemented)
- All servers use same Amazon login
- Cookies persist across IP changes

### 4. Error Handling
- Handle proxy failures gracefully
- Fallback to direct connection if proxy fails
- Retry with different IP on errors

### 5. Monitoring
- Monitor IP rotation success
- Track proxy failures
- Log IP changes for debugging

---

## Cost Estimates

### Option 1: Different IPs per Server
- **Server 1:** $5-10/month
- **Server 2:** $10-20/month
- **Server 3:** $10-20/month
- **Total:** ~$25-50/month
- **Proxy Cost:** $0

### Option 2: Proxy Rotation
- **Servers:** ~$25-50/month
- **Proxy Service:** $50-500/month (depending on traffic)
- **Total:** ~$75-550/month

### Option 3: VPN Rotation
- **Servers:** ~$25-50/month
- **VPN Service:** $10-15/month per server
- **Total:** ~$55-95/month

---

## Troubleshooting

### Workers not connecting through proxy
- Check proxy credentials
- Verify proxy server is accessible
- Test proxy connection manually

### IP not rotating
- Check proxy service settings
- Verify rotation is enabled
- Check proxy logs

### Rate limiting still happening
- Increase delays between requests
- Use more IPs (more servers or proxy pool)
- Reduce concurrent requests

### Cookies not working with proxy
- Cookies are shared via Redis (not affected by proxy)
- Verify Redis connection is working
- Check cookie sharing logs

---

## Security Considerations

1. **Proxy Credentials:** Store in `.env`, never commit to git
2. **VPN Credentials:** Use secure storage
3. **Network Security:** Use firewall rules
4. **Monitoring:** Watch for suspicious activity
5. **Backup:** Have fallback IPs/proxies ready

---

## Next Steps

1. Choose your IP rotation strategy
2. Set up servers following this guide
3. Configure proxy/VPN if using Option 2/3
4. Test IP rotation
5. Monitor and adjust as needed

