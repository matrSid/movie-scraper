'use strict';

const RUST_PROXY = 'https://rust-proxy-zh79.onrender.com/';
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── Scrape videasy player page to get the m3u8 URL ───────────────────────────
// Strategy (tried in order):
//   1. Fetch the player page HTML, look for the workers.dev m3u8 URL directly
//   2. Parse __NEXT_DATA__ JSON embedded in the page
//   3. Find any /api/ endpoint referenced in the page and call it
async function resolveVideasy(id, season, episode) {
  const pageUrl = season
    ? `https://player.videasy.net/tv/${id}/${season}/${episode || 1}`
    : `https://player.videasy.net/movie/${id}`;

  const pageRes = await fetch(pageUrl, {
    headers: {
      'User-Agent': UA,
      'Accept':     'text/html,application/xhtml+xml,*/*;q=0.9',
      'Referer':    'https://videasy.net/',
    }
  });

  if (!pageRes.ok) throw new Error(`videasy page returned ${pageRes.status}`);
  const html = await pageRes.text();

  // ── Strategy 1: direct URL in HTML ───────────────────────────────────────
  // Matches: https://bold.uskevinpowell89.workers.dev/video.m3u8?q=TOKEN|
  const directMatch = html.match(
    /https?:\/\/[^"'\s]+workers\.dev\/video\.m3u8\?q=[A-Za-z0-9+/=_|%-]+/
  );
  if (directMatch) {
    // Strip trailing pipe if present (seen in the wild: ?q=TOKEN|)
    return directMatch[0].replace(/\|$/, '');
  }

  // ── Strategy 2: __NEXT_DATA__ JSON ───────────────────────────────────────
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{.+?\})<\/script>/s);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      // Walk the props tree looking for anything that looks like an m3u8 URL
      const found = findM3u8InObject(nextData);
      if (found) return found;
    } catch (_) {}
  }

  // ── Strategy 3: find inline JSON blobs with a stream/source key ──────────
  // Some players embed { "source": "https://...m3u8..." } in a script tag
  const jsonBlobMatch = html.match(/"(?:source|stream|url|playlist|file)"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
  if (jsonBlobMatch) return jsonBlobMatch[1];

  // ── Strategy 4: find the API endpoint the page would call ─────────────────
  // e.g.  /api/source/550   or   /api/stream?id=550
  const apiPathMatch = html.match(/(?:fetch|axios\.get)\s*\(\s*["'`](\/api\/[^"'`]+)["'`]/);
  if (apiPathMatch) {
    const apiUrl = 'https://player.videasy.net' + apiPathMatch[1]
      .replace(':id',      id)
      .replace('{id}',     id)
      .replace(':movieId', id);

    const apiRes = await fetch(apiUrl, {
      headers: { 'User-Agent': UA, 'Referer': pageUrl }
    });
    if (apiRes.ok) {
      const apiData = await apiRes.json().catch(() => null);
      if (apiData) {
        const found = findM3u8InObject(apiData);
        if (found) return found;
      }
    }
  }

  // ── Strategy 5: brute-force any m3u8 URL in the HTML ─────────────────────
  const anyM3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/);
  if (anyM3u8) return anyM3u8[0];

  throw new Error('Could not find m3u8 URL in videasy page — page structure may have changed');
}

// Recursively walk a parsed JSON object looking for an m3u8 URL string
function findM3u8InObject(obj, depth = 0) {
  if (depth > 10) return null;
  if (typeof obj === 'string' && obj.includes('.m3u8')) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findM3u8InObject(item, depth + 1);
      if (found) return found;
    }
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      const found = findM3u8InObject(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── Parse headers + host embedded in a CDN URL's query string ────────────────
// Returns { headers, cleanUrl } — cleanUrl has ?headers= and ?host= stripped.
function parseEmbeddedHeaders(url) {
  try {
    const urlObj = new URL(url);
    const raw    = urlObj.searchParams.get('headers');
    const host   = urlObj.searchParams.get('host');
    const parsed = raw ? JSON.parse(raw) : {};
    if (host) {
      parsed.referer = parsed.referer || (host + '/');
      parsed.origin  = parsed.origin  || host;
    }
    urlObj.searchParams.delete('headers');
    urlObj.searchParams.delete('host');
    return { headers: parsed, cleanUrl: urlObj.toString() };
  } catch (_) {}
  return { headers: {}, cleanUrl: url };
}

// ── Fetch via Rust proxy ──────────────────────────────────────────────────────
async function fetchUpstream(url, extraHeaders = {}) {
  const headersObj = {
    'User-Agent': UA,
    ...(extraHeaders.referer || extraHeaders.Referer
      ? { Referer: extraHeaders.referer || extraHeaders.Referer }
      : {}),
    ...(extraHeaders.origin || extraHeaders.Origin
      ? { Origin: extraHeaders.origin || extraHeaders.Origin }
      : {}),
  };

  const proxyUrl = RUST_PROXY
    + '?url='     + encodeURIComponent(url)
    + '&headers=' + encodeURIComponent(JSON.stringify(headersObj));

  return fetch(proxyUrl);
}

// ── M3U8 rewriter ─────────────────────────────────────────────────────────────
function rewriteM3u8(body, originalUrl, selfBase) {
  const base    = originalUrl.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin  = new URL(originalUrl).origin;

  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;

    let absUrl;
    if (t.startsWith(RUST_PROXY)) {
      try { absUrl = new URL(t).searchParams.get('url') || t; }
      catch (_) { absUrl = t; }
    } else if (t.startsWith('http')) {
      absUrl = t;
    } else if (t.startsWith('/')) {
      absUrl = origin + t;
    } else {
      absUrl = baseDir + t;
    }

    return selfBase + '/api/hls?url=' + encodeURIComponent(absUrl);
  }).join('\n');
}

// ── SRT → WebVTT ──────────────────────────────────────────────────────────────
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// ── Pipe a fetch Response body into a Node ServerResponse ─────────────────────
async function pipeResponse(fetchRes, nodeRes) {
  const reader = fetchRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  nodeRes.end();
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const reqUrl = new URL(req.url, 'http://localhost');
  const route  = reqUrl.pathname;
  const q      = Object.fromEntries(reqUrl.searchParams);

  const selfBase = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : '';

  function json(statusCode, obj) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj, null, 2));
  }

  // ── /api/stream ──────────────────────────────────────────────────────────
  if (route === '/api/stream' || route === '/api/stream/') {
    if (!q.id) return json(400, { error: 'Missing required parameter: id' });

    try {
      const streamUrl = await resolveVideasy(q.id, q.s, q.e);
      const proxyUrl  = selfBase + '/api/hls?url=' + encodeURIComponent(streamUrl);
      const playerUrl = selfBase + '/player.html?url=' + encodeURIComponent(proxyUrl);

      return json(200, {
        id:      q.id,
        season:  q.s  || null,
        episode: q.e  || null,
        streamUrl,
        proxyUrl,
        playerUrl,
        subtitles:       [],
        defaultSubtitle: null,
      });
    } catch (err) {
      return json(500, { error: err.message });
    }
  }

  // ── /api/hls ─────────────────────────────────────────────────────────────
  if (route === '/api/hls' || route === '/api/hls/') {
    if (!q.url) return json(400, { error: 'Missing required parameter: url' });

    const url                       = decodeURIComponent(q.url);
    const { headers: extraHeaders,
            cleanUrl }              = parseEmbeddedHeaders(url);

    try {
      const upstream = await fetchUpstream(cleanUrl, extraHeaders);

      if (!upstream.ok && upstream.status !== 206) {
        res.statusCode = upstream.status;
        return res.end('Upstream error: ' + upstream.status);
      }

      const ct     = (upstream.headers.get('content-type') || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8')
                  || /\.m3u8?(\?|$)/i.test(cleanUrl.split('?')[0])
                  || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const body = await upstream.text();

        if (body.trimStart().startsWith('<')) {
          res.statusCode = 502;
          return res.end('Upstream returned an HTML error page (CDN block).');
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.statusCode = 200;
        return res.end(rewriteM3u8(body, cleanUrl, selfBase));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        const cl = upstream.headers.get('content-length');
        if (cl) res.setHeader('Content-Length', cl);
        res.statusCode = upstream.status;
        return pipeResponse(upstream, res);
      }
    } catch (err) {
      res.statusCode = 502;
      return res.end('HLS proxy error: ' + err.message);
    }
  }

  // ── /api/sub ─────────────────────────────────────────────────────────────
  if (route === '/api/sub' || route === '/api/sub/') {
    if (!q.url) return json(400, { error: 'Missing required parameter: url' });

    const url                       = decodeURIComponent(q.url);
    const { headers: extraHeaders,
            cleanUrl }              = parseEmbeddedHeaders(url);

    try {
      const upstream = await fetchUpstream(cleanUrl, extraHeaders);
      let body       = await upstream.text();

      const ct    = (upstream.headers.get('content-type') || '').toLowerCase();
      const isSrt = !ct.includes('vtt') &&
                    (url.includes('.srt') || /^\d+\r?\n\d{2}:\d{2}/.test(body.trim()));
      if (isSrt) body = srtToVtt(body);

      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return res.end(body);
    } catch (err) {
      res.statusCode = 502;
      return res.end('Sub proxy error: ' + err.message);
    }
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  return json(404, {
    error: 'Not found',
    routes: {
      'GET /api/stream': { params: 'id (required), s (season), e (episode)' },
      'GET /api/hls':    { params: 'url (encoded M3U8/segment URL)' },
      'GET /api/sub':    { params: 'url (encoded subtitle URL)' },
    },
  });
};