const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store: streamId -> { m3u8, lastExtracted, refreshing, browser, page }
const streamCache = {};

// ─── API PROXY ────────────────────────────────────────────────────────────────
app.get('/api/streams', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.ppv.to/api/streams', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'application/json',
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// ─── M3U8 EXTRACTOR ───────────────────────────────────────────────────────────
async function extractM3U8(iframeUrl, streamId) {
  console.log(`[${streamId}] Starting extraction from: ${iframeUrl}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });

    const page = await browser.newPage();

    await page.setRequestInterception(true);
    let foundM3U8 = null;

    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        foundM3U8 = url;
        console.log(`[${streamId}] Intercepted M3U8: ${url}`);
      }
      request.continue();
    });

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('.m3u8') && !foundM3U8) {
        foundM3U8 = url;
        console.log(`[${streamId}] Got M3U8 from response: ${url}`);
      }
    });

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Referer': 'https://pooembed.eu/',
    });

    await page.goto(iframeUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait up to 15s for M3U8
    for (let i = 0; i < 30 && !foundM3U8; i++) {
      await new Promise(r => setTimeout(r, 500));
    }

    // Also try clicking play button if present
    if (!foundM3U8) {
      try {
        await page.click('video, .play-button, [class*="play"], button');
        await new Promise(r => setTimeout(r, 5000));
      } catch (_) {}
    }

    await browser.close();

    return foundM3U8;
  } catch (err) {
    console.error(`[${streamId}] Extraction error:`, err.message);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// Continuous refresh loop for a stream
async function startRefreshLoop(streamId, iframeUrl) {
  const REFRESH_INTERVAL = 4 * 60 * 1000; // refresh every 4 minutes

  const run = async () => {
    if (!streamCache[streamId]) return; // stopped

    console.log(`[${streamId}] Refreshing M3U8...`);
    streamCache[streamId].refreshing = true;

    const m3u8 = await extractM3U8(iframeUrl, streamId);

    if (m3u8) {
      streamCache[streamId].m3u8 = m3u8;
      streamCache[streamId].lastExtracted = Date.now();
      console.log(`[${streamId}] Updated M3U8 -> ${m3u8}`);
    } else {
      console.warn(`[${streamId}] Failed to refresh M3U8, keeping old if available`);
    }

    streamCache[streamId].refreshing = false;

    // Schedule next refresh only if stream still active
    if (streamCache[streamId]) {
      setTimeout(run, REFRESH_INTERVAL);
    }
  };

  run();
}

// ─── STREAM ENDPOINT ─────────────────────────────────────────────────────────
// GET /stream?iframe=<url>&id=<id>
// Returns { m3u8: '...' } or waits until extracted
app.get('/stream', async (req, res) => {
  const { iframe, id } = req.query;
  if (!iframe || !id) return res.status(400).json({ error: 'Missing iframe or id' });

  const streamId = String(id);

  // If we already have a fresh M3U8 (< 5 min old), return it
  const cached = streamCache[streamId];
  if (cached && cached.m3u8 && (Date.now() - cached.lastExtracted) < 5 * 60 * 1000) {
    return res.json({ m3u8: cached.m3u8, cached: true });
  }

  // Initialize cache entry
  if (!streamCache[streamId]) {
    streamCache[streamId] = { m3u8: null, lastExtracted: 0, refreshing: false };
    startRefreshLoop(streamId, decodeURIComponent(iframe));
  }

  // Poll for up to 35 seconds
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if (streamCache[streamId] && streamCache[streamId].m3u8) {
      return res.json({ m3u8: streamCache[streamId].m3u8, cached: false });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  res.status(504).json({ error: 'M3U8 extraction timed out. Stream may not be live yet.' });
});

// Stop tracking a stream (optional cleanup)
app.delete('/stream/:id', (req, res) => {
  const { id } = req.params;
  delete streamCache[id];
  res.json({ ok: true });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
