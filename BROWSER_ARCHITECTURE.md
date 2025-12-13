# Browser Architecture & Sharing

## Can Browsers Be Shared Across Servers?

**Short Answer: No** - Browsers are local processes and cannot be shared across network.

**However:**
- ✅ Multiple workers on the **same server** can share one Chrome instance (via CDP)
- ✅ Session cookies/credentials can be shared via Redis
- ✅ Each server needs its own browser instance

## Current Architecture

### Same Server (Current Setup)
```
Server 1:
  Chrome Browser (CDP on port 9222)
    ├─ General Worker 1 (connects via CDP)
    ├─ General Worker 2 (connects via CDP)
    └─ Product Workers (connect via CDP)
```

**Benefits:**
- All workers share the same browser session
- Single login required
- Shared cookies/authentication
- Efficient resource usage

### Different Servers (Multi-Server Setup)
```
Server 1:
  Chrome Browser (CDP on port 9222)
    └─ General Worker 1

Server 2:
  Chrome Browser (CDP on port 9222)
    └─ General Worker 2
```

**Each server needs:**
- Its own Chrome instance
- Its own login session
- Cannot share browser across network

## Session Sharing Options

### Option 1: Share Cookies via Redis (Recommended)

**How it works:**
1. Manager worker or first general worker logs in
2. Extract cookies from browser
3. Store cookies in Redis
4. Other workers load cookies from Redis
5. Each worker uses cookies in its own browser

**Benefits:**
- Single login point
- Shared authentication
- Works across servers

**Implementation:**
- Extract cookies: `page.context().cookies()`
- Store in Redis: `REDIS_KEY_AMAZON_COOKIES`
- Load cookies: `context.addCookies(cookies)`

### Option 2: Share User Data Directory

**How it works:**
1. Use shared network storage (NFS, SMB)
2. All workers use same `--user-data-dir`
3. Chrome shares session automatically

**Limitations:**
- Only works on same network
- Requires shared storage
- Chrome locks can cause issues

### Option 3: Manual Login Per Server (Current)

**How it works:**
- Each server logs in separately
- Each maintains its own session
- No sharing needed

**Benefits:**
- Simple
- No coordination needed
- Works independently

## Recommended Approach

### For Same Server:
✅ **Share one Chrome instance** (current setup)
- All workers connect to same Chrome via CDP
- Single login session
- Most efficient

### For Different Servers:
✅ **Share cookies via Redis**
- Manager or first worker logs in
- Extract and store cookies
- Other workers load cookies
- Each server has its own browser

## Implementation: Cookie Sharing

### Step 1: Manager/First Worker Extracts Cookies

```typescript
// After login
const cookies = await page.context().cookies();
await redisConnection.set(
  REDIS_KEY_AMAZON_COOKIES, 
  JSON.stringify(cookies)
);
```

### Step 2: Other Workers Load Cookies

```typescript
// Before navigating
const cookiesStr = await redisConnection.get(REDIS_KEY_AMAZON_COOKIES);
if (cookiesStr) {
  const cookies = JSON.parse(cookiesStr);
  await context.addCookies(cookies);
}
```

## Current Flow Analysis

**Current behavior:**
- Each general worker checks login independently
- Each connects to its own Chrome instance (or shared on same server)
- No cookie sharing

**Issue:**
- If workers are on different servers, each needs separate login
- No credential sharing

**Solution:**
- Implement cookie sharing via Redis
- Manager or designated worker handles login
- Others reuse cookies

