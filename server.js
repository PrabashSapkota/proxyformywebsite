/**
 * Stream99 IPTV Proxy Server
 * Run: node server.js  (Node.js 18+, no npm install needed)
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const M3U_URL = 'https://raw.githubusercontent.com/dontknowhub/stream99/refs/heads/main/live_tv_channels.m3u';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fetchUrl(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer':    headers['referer']    || '',
        'Origin':     headers['origin']     || '',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
      }
    }, resolve);
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function bufferResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

// ─── M3U Rewriter ─────────────────────────────────────────────────────────────

function rewriteM3U(text, baseProxyUrl) {
  const lines = text.split('\n');
  const out = [];
  let pending = {};

  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('#EXTVLCOPT:http-referrer=')) {
      pending.referer = l.replace('#EXTVLCOPT:http-referrer=', '');
      out.push(l);
    } else if (l.startsWith('#EXTVLCOPT:http-origin=')) {
      pending.origin = l.replace('#EXTVLCOPT:http-origin=', '');
      out.push(l);
    } else if (l.startsWith('#EXTVLCOPT:http-user-agent=')) {
      pending.ua = l.replace('#EXTVLCOPT:http-user-agent=', '');
      out.push(l);
    } else if (l.startsWith('http') && !l.startsWith('#')) {
      const cleanUrl = l.split('|')[0].trim();
      const p = new URLSearchParams();
      p.set('url', cleanUrl);
      if (pending.referer) p.set('referer', pending.referer);
      if (pending.origin)  p.set('origin',  pending.origin);
      if (pending.ua)      p.set('ua',       pending.ua);
      out.push(`${baseProxyUrl}/stream?${p.toString()}`);
      pending = {};
    } else {
      out.push(l);
    }
  }
  return out.join('\n');
}

// ─── HLS Rewriter ─────────────────────────────────────────────────────────────

function rewriteHLS(text, originalUrl, referer, origin, ua, baseProxyUrl) {
  const base = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const absUrl = t.startsWith('http') ? t : base + t;
    const p = new URLSearchParams();
    p.set('url', absUrl);
    if (referer) p.set('referer', referer);
    if (origin)  p.set('origin',  origin);
    if (ua)      p.set('ua',      ua);
    return `${baseProxyUrl}/stream?${p.toString()}`;
  }).join('\n');
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q        = parsed.query;

  // Detect public URL (for Railway / Render the HOST header has the real domain)
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const baseProxyUrl = `${proto}://${host}`;

  // ── / → serve index.html ──
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── /playlist → fetch + rewrite M3U ──
  if (pathname === '/playlist') {
    try {
      const upstream = await fetchUrl(M3U_URL);
      const body     = await bufferResponse(upstream);
      const rewritten = rewriteM3U(body.toString('utf8'), baseProxyUrl);
      res.writeHead(200, { 'Content-Type': 'application/x-mpegurl; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(rewritten);
    } catch (e) {
      console.error('[playlist error]', e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Failed to fetch playlist: ' + e.message);
    }
    return;
  }

  // ── /stream?url=...&referer=...&origin=...&ua=... → proxy ──
  if (pathname === '/stream') {
    const targetUrl = q.url;
    if (!targetUrl) { res.writeHead(400); res.end('Missing url param'); return; }

    const referer = q.referer || '';
    const origin  = q.origin  || '';
    const ua      = q.ua      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    try {
      const upstream = await fetchUrl(targetUrl, {
        'user-agent': ua,
        'referer':    referer,
        'origin':     origin,
      });

      // Follow redirect
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        upstream.resume();
        const loc = upstream.headers.location;
        const absLoc = loc.startsWith('http') ? loc : new URL(loc, targetUrl).href;
        const p = new URLSearchParams({ url: absLoc });
        if (referer) p.set('referer', referer);
        if (origin)  p.set('origin',  origin);
        if (ua)      p.set('ua',      ua);
        res.writeHead(302, { 'Location': `/stream?${p.toString()}` });
        res.end();
        return;
      }

      const ct     = upstream.headers['content-type'] || '';
      const isM3U8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8');

      if (isM3U8) {
        const body     = await bufferResponse(upstream);
        const rewritten = rewriteHLS(body.toString('utf8'), targetUrl, referer, origin, ua, baseProxyUrl);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
        res.end(rewritten);
      } else {
        // Binary passthrough (.ts segments, keys, etc.)
        res.writeHead(upstream.statusCode, {
          'Content-Type':  ct || 'video/MP2T',
          'Cache-Control': 'no-cache',
          'Accept-Ranges': 'bytes',
        });
        upstream.pipe(res);
      }
    } catch (e) {
      console.error('[stream error]', targetUrl, e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + e.message);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅  Stream99 IPTV running at http://localhost:${PORT}`);
  console.log(`📺  Open http://localhost:${PORT} in your browser\n`);
});