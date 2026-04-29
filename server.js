const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Ad & tracker domains to block ───────────────────────────────────────────
const AD_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'adnxs.com', 'ads.yahoo.com', 'amazon-adsystem.com', 'moatads.com',
  'scorecardresearch.com', 'outbrain.com', 'taboola.com', 'revcontent.com',
  'zedo.com', 'advertising.com', 'adblade.com', 'adhigh.net',
  'adform.net', 'yieldmo.com', 'openx.net', 'rubiconproject.com',
  'pubmatic.com', 'contextweb.com', 'casalemedia.com', 'smartadserver.com',
  'adsrvr.org', 'cdn.ampproject.org', 'pagead2.googlesyndication.com',
  'ads.pubmatic.com', 'popads.net', 'popcash.net', 'hilltopads.net',
  'propellerads.com', 'trafficjunky.net', 'juicyads.com', 'exoclick.com',
  'trafficstars.com', 'plugrush.com', 'adsterra.com', 'clickadu.com',
  'bidvertiser.com', 'yllix.com', 'evadav.com', 'richpush.co',
];

// ─── Ad-related script patterns to strip ─────────────────────────────────────
const AD_SCRIPT_PATTERNS = [
  /googletag/i, /adsbygoogle/i, /doubleclick/i, /adnxs/i,
  /amazon-adsystem/i, /outbrain/i, /taboola/i, /popads/i,
  /exoclick/i, /adsterra/i, /propellerads/i, /juicyads/i,
  /trafficjunky/i, /hilltopads/i, /popcash/i,
];

// ─── CORS + headers ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Main proxy route ─────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Stream Proxy</title>
      <style>body{font-family:sans-serif;max-width:600px;margin:80px auto;text-align:center;}
      input{width:80%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:4px;}
      button{padding:10px 20px;font-size:16px;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:10px;}
      </style></head>
      <body>
        <h2>🔒 Ad-Free Stream Proxy</h2>
        <p>Append <code>?url=YOUR_STREAM_URL</code> to use this proxy.</p>
        <input id="u" placeholder="Paste iframe/stream URL here..." />
        <br/>
        <button onclick="window.location='/?url='+encodeURIComponent(document.getElementById('u').value)">Open Proxied Stream</button>
      </body></html>
    `);
  }

  let url;
  try {
    url = new URL(decodeURIComponent(targetUrl));
  } catch {
    return res.status(400).send('Invalid URL');
  }

  // Block known ad domains outright
  if (AD_DOMAINS.some(d => url.hostname.includes(d))) {
    return res.status(403).send('Blocked ad domain');
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': url.origin,
        'Origin': url.origin,
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';

    // ── For HTML pages: scrub ads then wrap in fullscreen iframe ──────────────
    if (contentType.includes('text/html')) {
      let html = await response.text();
      const $ = cheerio.load(html);

      // Remove ad scripts
      $('script').each((_, el) => {
        const src = $(el).attr('src') || '';
        const inline = $(el).html() || '';
        if (
          AD_DOMAINS.some(d => src.includes(d)) ||
          AD_SCRIPT_PATTERNS.some(p => p.test(src) || p.test(inline))
        ) {
          $(el).remove();
        }
      });

      // Remove ad iframes
      $('iframe').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (AD_DOMAINS.some(d => src.includes(d))) $(el).remove();
      });

      // Remove common ad container elements
      $('[id*="ad"],[class*="ad-"],[class*="-ad"],[class*="ads"],[id*="banner"],[class*="banner"],[class*="popup"],[id*="popup"],[class*="overlay"],[id*="overlay"]').each((_, el) => {
        // Only remove if it looks like an ad wrapper (no video/source inside)
        if (!$(el).find('video,source').length) $(el).remove();
      });

      // Rewrite relative URLs to go through proxy
      const base = url.origin;
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && !href.startsWith('http') && !href.startsWith('//')) {
          $(el).attr('href', `/?url=${encodeURIComponent(base + '/' + href.replace(/^\//, ''))}`);
        }
      });

      // Fix absolute URLs for media
      $('source[src],video[src],img[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && src.startsWith('/') && !src.startsWith('//')) {
          $(el).attr('src', base + src);
        }
      });

      // Remove X-Frame-Options & CSP interference by injecting override meta
      $('head').prepend(`
        <meta http-equiv="Content-Security-Policy" content="">
        <style>
          /* Kill ad containers */
          [class*="ad-wrap"],[class*="advert"],[id*="advert"],
          .popup,.overlay,.modal-backdrop,#cookie-banner,
          [class*="cookie-"],[id*="cookie"],[class*="gdpr"] {
            display:none!important;visibility:hidden!important;opacity:0!important;
            pointer-events:none!important;
          }
        </style>
        <script>
          // Block window.open popups
          window.open = function(){ return null; };
          // Block onbeforeunload popups
          window.onbeforeunload = null;
          // Remove popups added dynamically
          const _obs = new MutationObserver(() => {
            document.querySelectorAll(
              '[class*="popup"],[id*="popup"],[class*="overlay"],[id*="overlay"],' +
              '[class*="modal"]:not([class*="video"]),[class*="interstitial"]'
            ).forEach(el => {
              if(!el.querySelector('video,source,iframe')) el.remove();
            });
          });
          _obs.observe(document.body || document.documentElement, {childList:true, subtree:true});
        </script>
      `);

      // Deliver clean HTML
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.removeHeader('X-Frame-Options');
      return res.send($.html());
    }

    // ── For non-HTML (JS, CSS, media, etc.): pipe through transparently ───────
    res.setHeader('Content-Type', contentType);
    // Strip security headers that block embedding
    const skip = ['x-frame-options','content-security-policy','x-content-type-options'];
    response.headers.forEach((val, key) => {
      if (!skip.includes(key.toLowerCase())) res.setHeader(key, val);
    });
    response.body.pipe(res);

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

// ─── Sub-resource proxy: /proxy?url=... for JS/CSS/images fetched by proxied page
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('No URL');

  let url;
  try { url = new URL(decodeURIComponent(targetUrl)); } catch { return res.status(400).send('Bad URL'); }
  if (AD_DOMAINS.some(d => url.hostname.includes(d))) return res.status(204).end();

  try {
    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' },
    });
    const contentType = response.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.body.pipe(res);
  } catch {
    res.status(500).end();
  }
});

app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
