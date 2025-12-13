# Deployment Guide

## Why Not Vercel?

Vercel is designed for serverless functions and static sites. Our services need:
- **Manager Worker**: Long-running process that polls Redis continuously
- **API**: Persistent HTTP server with database connections

Vercel's serverless model doesn't support long-running processes, making it unsuitable for the manager worker.

## Recommended Platforms

### Option 1: Railway (Recommended) ⭐
**Best for**: Easy deployment, good free tier, supports long-running processes

```bash
# Install Railway CLI
npm i -g @railway/cli

# Deploy
railway login
railway init
railway up
```

**Features:**
- ✅ Supports long-running processes
- ✅ Built-in Redis and MySQL
- ✅ Automatic HTTPS
- ✅ Environment variables management
- ✅ Free tier available
- ✅ Easy scaling

**Pricing**: Free tier available, then ~$5/month per service

---

### Option 2: Render
**Best for**: Simple deployment, good documentation

**Features:**
- ✅ Supports background workers
- ✅ Managed Redis and PostgreSQL
- ✅ Free tier available
- ✅ Automatic deployments from Git

**Pricing**: Free tier available, then ~$7/month per service

---

### Option 3: Fly.io
**Best for**: Global distribution, Docker support

**Features:**
- ✅ Supports long-running processes
- ✅ Global edge deployment
- ✅ Docker-based
- ✅ Free tier available

**Pricing**: Free tier available, then pay-as-you-go

---

### Option 4: DigitalOcean App Platform
**Best for**: Predictable pricing, good performance

**Features:**
- ✅ Supports background workers
- ✅ Managed databases
- ✅ Auto-scaling
- ✅ No free tier but reasonable pricing

**Pricing**: ~$5/month per service

---

### Option 5: Self-Hosted VPS
**Best for**: Full control, cost-effective at scale

**Recommended providers:**
- DigitalOcean Droplets ($6/month)
- Linode ($5/month)
- Vultr ($6/month)
- Hetzner (€4/month)

**Setup:**
```bash
# Install Node.js, PM2, and services
# Use PM2 to keep services running
npm install -g pm2
pm2 start manager-worker/src/index.ts --name manager
pm2 start api/src/index.ts --name api
pm2 save
pm2 startup
```

---

## Deployment Architecture

### Recommended Setup:

**Instance 1 (Main Server):**
- Manager Worker
- API Server
- Can be on Railway, Render, or VPS

**Instance 2+ (Worker Servers):**
- General Workers
- Product Workers
- Can be on VPS, Railway, or any platform supporting long-running processes

**External Services:**
- Redis: Railway, Upstash, or Redis Cloud
- MySQL: Railway, PlanetScale, or managed MySQL

---

## Quick Start with Railway

1. **Install Railway CLI:**
```bash
npm i -g @railway/cli
```

2. **Login:**
```bash
railway login
```

3. **Create projects:**
```bash
# For Manager + API
railway init
railway add redis
railway add mysql

# Set environment variables
railway variables set REDIS_URL=${{Redis.REDIS_URL}}
railway variables set DATABASE_URL=${{MySQL.DATABASE_URL}}
railway variables set API_PORT=3000
```

4. **Deploy:**
```bash
railway up
```

---

## Environment Variables Needed

```env
# Required
REDIS_URL=redis://...
DATABASE_URL=mysql://...
API_PORT=3000

# For Manager Worker
LOG_LEVEL=info

# For API
LOG_LEVEL=info
```

---

## Monitoring

- Use Railway's built-in logs
- Or use PM2 for self-hosted: `pm2 monit`
- Consider adding Sentry for error tracking

---

## Cost Comparison

| Platform | Free Tier | Paid Tier | Best For |
|----------|-----------|-----------|----------|
| Railway | ✅ Yes | ~$5/mo | Easiest setup |
| Render | ✅ Yes | ~$7/mo | Simple deployment |
| Fly.io | ✅ Yes | Pay-as-you-go | Global distribution |
| DigitalOcean | ❌ No | ~$5/mo | Predictable pricing |
| VPS | ❌ No | ~$5-10/mo | Full control |

---

## Recommendation

**For most users**: Start with **Railway** - it's the easiest to set up and has a good free tier.

**For production at scale**: Use **DigitalOcean App Platform** or **self-hosted VPS** for better cost control.

