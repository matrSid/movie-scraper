'use strict';

const RUST_PROXY = 'https://rust-proxy-zh79.onrender.com/';
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// Free TMDB API key (v3 read-only public key — replace with your own if needed)
// You can get one free at https://www.themoviedb.org/settings/api
const TMDB_KEY   = process.env.TMDB_API_KEY || '86da74c5c11f2b69a4ce724f254ac312';

// ── Step 1: Get title/year/imdbId from TMDB ───────────────────────────────────
async function getTmdbMeta(tmdbId, mediaType) {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY env var not set');

  const type   = mediaType === 'tv' ? 'tv' : 'movie';
  const url     = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=external_ids`;
  const res     = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TMDB returned ${res.status} for id ${tmdbId}`);

  const data    = await res.json();
  const title   = data.title || data.name || '';
  const year    = (data.release_date || data.first_air_date || '').slice(0, 4);
  const imdbId  = data.imdb_id || data.external_ids?.imdb_id || '';

  if (!title) throw new Error('TMDB returned no title');
  return { title, year, imdbId };
}

// ── Step 2: Call videasy API to get the m3u8 URL ─────────────────────────────
async function resolveVideasy(tmdbId, season, episode) {
  const mediaType = season ? 'tv' : 'movie';
  const { title, year, imdbId } = await getTmdbMeta(tmdbId, mediaType);

  const params = new URLSearchParams({
    title:     title,
    mediaType: mediaType,
    year:      year,
    episodeId: episode || '1',
    seasonId:  season  || '1',
    tmdbId:    String(tmdbId),
    imdbId:    imdbId,
  });

  const apiUrl = `https://api.videasy.net/myflixerzupcloud/sources-with-title?${params}`;
  const res    = await fetch(apiUrl, {
    headers: {
      'User-Agent': UA,
      'Referer':    'https://player.videasy.net/',
      'Origin':     'https://player.videasy.net',
    }
  });

  if (!res.ok) throw new Error(`videasy API returned ${res.status}`);

  const data = await res.json();

  // Response shape is unknown — try common patterns
  // Pattern A: { url: "...m3u8" }
  // Pattern B: { sources: [{ url: "...m3u8" }] }
  // Pattern C: { stream: { url: "..." } }
  // Pattern D: { data: { url: "..." } }
  const m3u8 = data?.url
    || data?.stream?.url
    || data?.data?.url
    || data?.sources?.[0]?.url
    || data?.data?.sources?.[0]?.url
    || findM3u8InObject(data);

  if (!m3u8) {
    // Return raw response so we can inspect it and adjust
    throw new Error('videasy: could not find m3u8 in response: ' + JSON.stringify(data).slice(0, 500));
  }

  return { m3u8, title, year, imdbId };
}

// Recursively walk a parsed JSON object looking for an m3u8 URL string
function findM3u8InObject(obj, depth = 0) {
  if (depth > 8) return null;
  if (typeof obj === 'string' && (obj.includes('.m3u8') || obj.includes('workers.dev'))) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = findM3u8InObject(item, depth + 1);
      if (f) return f;
    }
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      const f = findM3u8InObject(val, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

// ── Parse headers + host embedded in a CDN URL's query string ────────────────
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
  const headersObj = { 'User-Agent': UA };
  const ref = extraHeaders.referer || extraHeaders.Referer;
  const ori = extraHeaders.origin  || extraHeaders.Origin;
  if (ref) headersObj.Referer = ref;
  if (ori) headersObj.Origin  = ori;

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
      const { m3u8, title, year, imdbId } = await resolveVideasy(q.id, q.s, q.e);
      const proxyUrl  = selfBase + '/api/hls?url=' + encodeURIComponent(m3u8);
      const playerUrl = selfBase + '/player.html?url=' + encodeURIComponent(proxyUrl);

      return json(200, {
        id:      q.id,
        season:  q.s  || null,
        episode: q.e  || null,
        title,
        year,
        imdbId,
        streamUrl: m3u8,
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

    const url                  = decodeURIComponent(q.url);
    const { headers: xh,
            cleanUrl }         = parseEmbeddedHeaders(url);

    try {
      const upstream = await fetchUpstream(cleanUrl, xh);

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

    const url              = decodeURIComponent(q.url);
    const { headers: xh,
            cleanUrl }     = parseEmbeddedHeaders(url);

    try {
      const upstream = await fetchUpstream(cleanUrl, xh);
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
      'GET /api/stream': { params: 'id (tmdbId, required), s (season), e (episode)' },
      'GET /api/hls':    { params: 'url (encoded M3U8/segment URL)' },
      'GET /api/sub':    { params: 'url (encoded subtitle URL)' },
    },
  });
};