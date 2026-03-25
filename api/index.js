'use strict';

const fs   = require('fs');
const path = require('path');

const REFERER    = 'https://vidlink.pro/';
const ORIGIN     = 'https://vidlink.pro';
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';
const RUST_PROXY = 'https://rust-proxy-zh79.onrender.com/';

// ── WASM singleton ────────────────────────────────────────────────────────────
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window   = globalThis;
    globalThis.self     = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    require(path.join(process.cwd(), 'api', 'script.js'));

    const go      = new Dm();
    const wasmBuf = fs.readFileSync(path.join(process.cwd(), 'api', 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
  })();
  return bootPromise;
}

// ── Parse headers + host embedded in a CDN URL's query string ────────────────
// Returns { headers, cleanUrl } where cleanUrl has ?headers= and ?host= stripped
// so the CDN never receives those meta-params.
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
    // Strip our meta-params before forwarding to CDN
    urlObj.searchParams.delete('headers');
    urlObj.searchParams.delete('host');
    return { headers: parsed, cleanUrl: urlObj.toString() };
  } catch (_) {}
  return { headers: {}, cleanUrl: url };
}

// ── Fetch via Rust proxy ──────────────────────────────────────────────────────
// url should be the CLEAN url (no ?headers=/?host= junk).
// extraHeaders are forwarded to the CDN via the Rust proxy's &headers= param.
async function fetchUpstream(url, extraHeaders = {}) {
  const headersObj = {
    Referer:      extraHeaders.referer || extraHeaders.Referer || REFERER,
    Origin:       extraHeaders.origin  || extraHeaders.Origin  || ORIGIN,
    'User-Agent': UA,
  };

  const proxyUrl = RUST_PROXY
    + '?url='     + encodeURIComponent(url)
    + '&headers=' + encodeURIComponent(JSON.stringify(headersObj));

  return fetch(proxyUrl);
}

// ── M3U8 rewriter ─────────────────────────────────────────────────────────────
// Rewrites every segment / child-playlist line to go through /api/hls.
// Handles lines the Rust proxy may have already rewritten to point at itself.
function rewriteM3u8(body, originalUrl, selfBase) {
  const base    = originalUrl.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin  = new URL(originalUrl).origin;

  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;

    let absUrl;
    if (t.startsWith(RUST_PROXY)) {
      // Rust proxy has already rewritten this line — unwrap the original URL
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

// ── Normalise subtitle tracks ─────────────────────────────────────────────────
function extractSubtitles(data, selfBase) {
  const raw =
    data?.stream?.captions  ||
    data?.stream?.tracks    ||
    data?.stream?.subtitles ||
    data?.captions          ||
    data?.tracks            ||
    [];

  return raw
    .filter(t => {
      const kind = (t.kind || '').toLowerCase();
      return !kind || kind === 'captions' || kind === 'subtitles';
    })
    .map(t => {
      const url      = t.file || t.src || t.url || '';
      const label    = t.label || t.language || 'Unknown';
      const language = (t.language || t.label || '').toLowerCase();
      return {
        label,
        language,
        url,
        proxyUrl: selfBase + '/api/sub?url=' + encodeURIComponent(url),
      };
    })
    .filter(t => t.url);
}

// ── Core stream resolver ──────────────────────────────────────────────────────
async function resolveStream(id, season, episode, selfBase) {
  await bootWasm();

  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);

  const data     = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');

  return {
    streamUrl: playlist,
    subtitles: extractSubtitles(data, selfBase),
  };
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
      const { streamUrl, subtitles } = await resolveStream(q.id, q.s, q.e, selfBase);

      const proxyUrl = selfBase + '/api/hls?url=' + encodeURIComponent(streamUrl);

      const defaultSubtitle = subtitles.find(s =>
        /^en$/i.test(s.language) || /english/i.test(s.label)
      ) || subtitles[0] || null;

      const playerUrl = selfBase + '/player.html?url='
        + encodeURIComponent(proxyUrl)
        + (defaultSubtitle ? '&sub=' + encodeURIComponent(defaultSubtitle.proxyUrl) : '');

      return json(200, {
        id:      q.id,
        season:  q.s  || null,
        episode: q.e  || null,
        streamUrl,
        proxyUrl,
        playerUrl,
        subtitles,
        defaultSubtitle,
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
      // Check extension on both raw and clean URL (extension may live in an
      // encoded path segment before the query string)
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
        // Use cleanUrl as base for resolving relative segment URLs
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