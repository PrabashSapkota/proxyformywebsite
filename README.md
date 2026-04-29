# LiveSports — Self-Hosted Stream Site

A complete live sports streaming site that:
- Fetches matches from `api.ppv.to/api/streams`
- Extracts M3U8 links via Puppeteer (headless Chrome)
- Continuously refreshes tokenized M3U8 every 4 minutes
- Plays streams via Clappr HLS player in a full-screen watch page

---

## File Structure

```
streamsite/
├── server.js          # Express backend + Puppeteer M3U8 extractor
├── package.json
├── render.yaml        # Render deployment config
└── public/
    ├── index.html     # Listings page (all matches with filters)
    └── watch.html     # Full-screen player page
```

---

## How It Works

1. **Listings page** (`/`) fetches `/api/streams` (proxied from ppv.to) and shows cards
2. **Clicking a match** opens `watch.html?id=X&iframe=<url>&title=<name>` in a new tab
3. **Watch page** calls `/stream?id=X&iframe=<url>` on the backend
4. **Backend** launches Puppeteer, loads the iframe, intercepts the `.m3u8` request
5. **M3U8 is returned** to the frontend and loaded into Clappr
6. **Every 4 minutes**, the backend re-extracts a fresh M3U8 (before tokens expire)
7. **Frontend also refreshes** the source at the same interval

---

## Deploy to Render

### Option 1: render.yaml (Blueprint)
1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your repo → Render reads `render.yaml` automatically
4. Deploy ✅

### Option 2: Manual Web Service
1. Go to Render → New → Web Service
2. Connect your GitHub repo
3. Set:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Add environment variable: `NODE_ENV=production`
5. Click **Create Web Service**

### ⚠️ Puppeteer on Render

Render's Linux environment includes Chromium. However you need to ensure it's available:

**Add a build command that installs Chrome dependencies:**
```
apt-get install -y libgbm-dev && npm install
```

Or use the `PUPPETEER_EXECUTABLE_PATH` env var to point to the system Chromium:
```
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

**Recommended: Use `puppeteer-core` + system Chrome on Render:**

Change in `package.json`:
```json
"puppeteer": "^22.0.0"
```
→ This version auto-downloads Chromium during `npm install` which works on Render Starter plans.

---

## Local Development

```bash
npm install
node server.js
# Open http://localhost:3000
```

---

## URLs

| URL | Purpose |
|-----|---------|
| `/` | Match listings |
| `/watch.html?id=X&iframe=URL&title=NAME` | Watch a stream |
| `/api/streams` | Proxied match data |
| `/stream?id=X&iframe=URL` | Get M3U8 for a stream |
| `DELETE /stream/:id` | Stop tracking a stream |

---

## Notes

- The M3U8 extraction takes **up to 35 seconds** on first load (Puppeteer boot time)
- On Render **Starter plan**, cold starts add extra latency — consider upgrading to Standard
- Streams are cached in-memory; server restart clears all streams
- The refresh loop runs every **4 minutes** to beat token expiry
