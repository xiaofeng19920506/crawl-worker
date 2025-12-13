# Multi-Server Setup Guide

## Architecture Overview

```
┌─────────────────────────────────┐
│  Server 1 (Main/Control)       │
│  - Manager Worker                │
│  - API Server                     │
│  - Redis (or connect to shared)  │
│  - MySQL (or connect to shared)  │
└─────────────────────────────────┘
              ↓ (Redis)
┌─────────────────────────────────┐
│  Server 2 (Workers)             │
│  - General Worker (ID: 1)        │
│  - Product Workers (ID: 1, 2)    │
│  - Chrome Browser (CDP)          │
└─────────────────────────────────┘
              ↓ (Redis)
┌─────────────────────────────────┐
│  Server 3 (Workers)             │
│  - General Worker (ID: 2)        │
│  - Product Workers (ID: 3, 4)    │
│  - Chrome Browser (CDP)          │
└─────────────────────────────────┘
```

## Prerequisites

All servers need:
- Node.js >= 18.18.0
- Network access to shared Redis
- Network access to shared MySQL database
- (For workers) Chrome browser installed

---

## Server 1: Main Server (Manager + API)

### Setup

1. **Install dependencies:**
```bash
git clone <repo>
cd vine
npm install
```

2. **Install PM2 (process manager):**
```bash
npm install -g pm2
```

3. **Create `.env` file:**
```env
# Redis (can be local or remote)
REDIS_URL=redis://localhost:6379
# Or remote: REDIS_URL=redis://server2-ip:6379

# Database (can be local or remote)
DATABASE_URL=mysql://user:password@localhost:3307/vine
# Or remote: DATABASE_URL=mysql://user:password@server2-ip:3307/vine

# API
API_PORT=3000

# Logging
LOG_LEVEL=info
```

4. **Start services with PM2:**
```bash
# Start Manager Worker
pm2 start npm --name "manager" -- run start:manager-worker

# Start API
pm2 start npm --name "api" -- run start:api

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Follow the command it outputs
```

5. **Monitor services:**
```bash
pm2 status
pm2 logs manager
pm2 logs api
pm2 monit
```

---

## Server 2: Worker Server #1

### Setup

1. **Install dependencies:**
```bash
git clone <repo>
cd vine
npm install
```

2. **Install Chrome (if not already installed):**
```bash
# Ubuntu/Debian
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'
sudo apt-get update
sudo apt-get install -y google-chrome-stable

# Or use Chromium
sudo apt-get install -y chromium-browser
```

3. **Install Playwright browsers:**
```bash
npx playwright install chromium
```

4. **Create `.env` file:**
```env
# Redis (connect to Server 1 or shared Redis)
REDIS_URL=redis://server1-ip:6379

# Database (connect to Server 1 or shared MySQL)
DATABASE_URL=mysql://user:password@server1-ip:3307/vine

# Worker IDs
GENERAL_WORKER_ID=1
PRODUCT_WORKER_ID=1
# Or run multiple product workers with different IDs

# Chrome CDP (if using remote Chrome)
PLAYWRIGHT_CDP_ENDPOINT=http://localhost:9222

# Logging
LOG_LEVEL=info
```

5. **Start Chrome with remote debugging:**
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

6. **Start services with PM2:**
```bash
# Start General Worker
GENERAL_WORKER_ID=1 pm2 start npm --name "general-1" -- run start:general-worker

# Start Product Workers (multiple instances)
PRODUCT_WORKER_ID=1 pm2 start npm --name "product-1" -- run start:product-worker
PRODUCT_WORKER_ID=2 pm2 start npm --name "product-2" -- run start:product-worker

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
```

7. **Create systemd service for Chrome (optional):**
```bash
sudo nano /etc/systemd/system/chrome-debug.service
```

```ini
[Unit]
Description=Chrome with Remote Debugging
After=network.target

[Service]
Type=simple
User=your-username
ExecStart=/usr/local/bin/start-chrome-debug.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable chrome-debug
sudo systemctl start chrome-debug
```

---

## Server 3: Worker Server #2

### Setup

Follow the same steps as Server 2, but with different worker IDs:

```env
# Different worker IDs
GENERAL_WORKER_ID=2
PRODUCT_WORKER_ID=3
# Or PRODUCT_WORKER_ID=4 for another worker
```

**Start services:**
```bash
GENERAL_WORKER_ID=2 pm2 start npm --name "general-2" -- run start:general-worker
PRODUCT_WORKER_ID=3 pm2 start npm --name "product-3" -- run start:product-worker
PRODUCT_WORKER_ID=4 pm2 start npm --name "product-4" -- run start:product-worker
```

---

## Network Configuration

### Firewall Rules

**Server 1 (Main):**
- Open port 3000 (API)
- Open port 6379 (Redis, if hosting locally)
- Open port 3307 (MySQL, if hosting locally)

**Server 2 & 3 (Workers):**
- Open port 9222 (Chrome CDP, if accessing remotely)
- Allow outbound to Server 1 (Redis, MySQL)

### Redis Access

If Redis is on Server 1, make sure it's accessible:
```bash
# On Server 1, edit Redis config
sudo nano /etc/redis/redis.conf

# Change:
bind 0.0.0.0  # Instead of 127.0.0.1

# Restart Redis
sudo systemctl restart redis
```

### MySQL Access

If MySQL is on Server 1, allow remote connections:
```bash
# On Server 1, edit MySQL config
sudo nano /etc/mysql/mysql.conf.d/mysqld.cnf

# Change:
bind-address = 0.0.0.0  # Instead of 127.0.0.1

# Create remote user
mysql -u root -p
CREATE USER 'vine_user'@'%' IDENTIFIED BY 'password';
GRANT ALL PRIVILEGES ON vine.* TO 'vine_user'@'%';
FLUSH PRIVILEGES;

# Restart MySQL
sudo systemctl restart mysql
```

---

## Environment Variables Summary

### Server 1 (.env)
```env
REDIS_URL=redis://localhost:6379
DATABASE_URL=mysql://user:password@localhost:3307/vine
API_PORT=3000
LOG_LEVEL=info
```

### Server 2 (.env)
```env
REDIS_URL=redis://server1-ip:6379
DATABASE_URL=mysql://user:password@server1-ip:3307/vine
GENERAL_WORKER_ID=1
PRODUCT_WORKER_ID=1
PLAYWRIGHT_CDP_ENDPOINT=http://localhost:9222
LOG_LEVEL=info
```

### Server 3 (.env)
```env
REDIS_URL=redis://server1-ip:6379
DATABASE_URL=mysql://user:password@server1-ip:3307/vine
GENERAL_WORKER_ID=2
PRODUCT_WORKER_ID=3
PLAYWRIGHT_CDP_ENDPOINT=http://localhost:9222
LOG_LEVEL=info
```

---

## PM2 Management Commands

### View Status
```bash
pm2 status
pm2 list
```

### View Logs
```bash
pm2 logs                    # All services
pm2 logs manager           # Manager only
pm2 logs general-1        # General worker 1
pm2 logs product-1        # Product worker 1
pm2 logs --lines 100       # Last 100 lines
```

### Restart Services
```bash
pm2 restart all            # All services
pm2 restart manager        # Specific service
pm2 restart general-1
```

### Stop Services
```bash
pm2 stop all
pm2 stop manager
```

### Delete Services
```bash
pm2 delete manager
pm2 delete all
```

### Monitor Resources
```bash
pm2 monit
```

---

## Startup Scripts

### Server 1 Startup Script
```bash
#!/bin/bash
# /usr/local/bin/start-vine-main.sh

cd /path/to/vine
pm2 start npm --name "manager" -- run start:manager-worker
pm2 start npm --name "api" -- run start:api
pm2 save
```

### Server 2/3 Startup Script
```bash
#!/bin/bash
# /usr/local/bin/start-vine-workers.sh

# Start Chrome
/usr/local/bin/start-chrome-debug.sh
sleep 5

# Start workers
cd /path/to/vine
GENERAL_WORKER_ID=1 pm2 start npm --name "general-1" -- run start:general-worker
PRODUCT_WORKER_ID=1 pm2 start npm --name "product-1" -- run start:product-worker
PRODUCT_WORKER_ID=2 pm2 start npm --name "product-2" -- run start:product-worker
pm2 save
```

---

## Troubleshooting

### Workers not connecting to Redis
- Check firewall rules
- Verify Redis is listening on 0.0.0.0
- Test connection: `redis-cli -h server1-ip ping`

### Workers not connecting to Database
- Check MySQL remote access is enabled
- Verify user permissions
- Test connection: `mysql -h server1-ip -u user -p`

### Chrome CDP not accessible
- Verify Chrome is running: `ps aux | grep chrome`
- Check port 9222 is open: `netstat -tlnp | grep 9222`
- Test: `curl http://localhost:9222/json/version`

### PM2 services not starting
- Check logs: `pm2 logs`
- Verify Node.js version: `node --version`
- Check environment variables: `pm2 env <id>`

---

## Scaling

To add more workers:
1. Add more product workers on existing servers
2. Or add Server 4, 5, etc. with same setup
3. Manager automatically detects new workers via heartbeats
4. No configuration changes needed!

---

## Security Considerations

1. **Use strong passwords** for Redis and MySQL
2. **Restrict network access** - only allow connections from worker servers
3. **Use SSH keys** instead of passwords
4. **Keep systems updated**
5. **Monitor logs** for suspicious activity
6. **Use firewall** to restrict ports

---

## Cost Estimate

**3 Servers Setup:**
- Server 1 (Main): $5-10/month (can be smaller)
- Server 2 (Workers): $10-20/month (needs more RAM for Chrome)
- Server 3 (Workers): $10-20/month

**Total: ~$25-50/month** for 3 servers

Much cheaper than cloud platforms at scale!

