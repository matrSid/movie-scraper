'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

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

    eval(fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8'));

    const go     = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, '..', 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
  })();
  return bootPromise;
}

// ── Upstream HTTP fetcher (redirect-aware) ────────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(
          loc.startsWith('http') ? loc : new URL(loc, url).href,
          redirects + 1
        ));
      }
      resolve(res);
    }).on('error', reject);
  });
}

// ── M3U8 rewriter — rewrites segment/playlist URLs through our proxy ──────────
function rewriteM3u8(body, url, baseProxyUrl) {
  const base    = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin  = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t
              : t.startsWith('/')    ? origin + t
              :                        baseDir + t;
    return baseProxyUrl + encodeURIComponent(abs);
  }).join('\n');
}

// ── SRT → WebVTT conversion ───────────────────────────────────────────────────
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// ── Normalise subtitle tracks from API response ───────────────────────────────
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
        url,                                                    // original URL
        proxyUrl: selfBase + '/api/sub?url=' + encodeURIComponent(url),  // CORS-safe proxy
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

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTE TABLE
//  GET /api/stream?id=&[s=&e=]   →  { streamUrl, proxyUrl, subtitles[] }
//  GET /api/hls?url=              →  proxied / rewritten M3U8 or TS segment
//  GET /api/sub?url=              →  proxied subtitle (auto-converts SRT→VTT)
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // ── CORS — allow any origin to call this API ────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const reqUrl  = new URL(req.url, 'http://localhost');
  const route   = reqUrl.pathname;          // e.g. /api/stream
  const q       = Object.fromEntries(reqUrl.searchParams);
  const selfBase = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : '';                                   // empty string = relative URLs in dev

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

      // The proxied HLS URL rewrites segments through /api/hls so CORS is
      // never a problem when embedding on a different domain.
      const proxyUrl = selfBase + '/api/hls?url=' + encodeURIComponent(streamUrl);

      return json(200, {
        id:        q.id,
        season:    q.s    || null,
        episode:   q.e    || null,
        streamUrl,          // raw M3U8 (use if you control the player host)
        proxyUrl,           // CORS-safe proxied M3U8 (use for cross-origin embeds)
        subtitles,          // [{ label, language, url, proxyUrl }]
        // Convenience: English track first (or null)
        defaultSubtitle: subtitles.find(s =>
          /^en$/i.test(s.language) || /english/i.test(s.label)
        ) || subtitles[0] || null,
      });
    } catch (err) {
      return json(500, { error: err.message });
    }
  }

  // ── /api/hls  (M3U8 / segment proxy) ────────────────────────────────────
  if (route === '/api/hls' || route === '/api/hls/') {
    if (!q.url) return json(400, { error: 'Missing required parameter: url' });
    const url = decodeURIComponent(q.url);
    try {
      const upstream = await fetchUpstream(url);
      const ct       = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8   = ct.includes('mpegurl') || ct.includes('m3u8')
                    || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body    = Buffer.concat(chunks).toString('utf8');
        const baseProxy = selfBase + '/api/hls?url=';
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url, baseProxy));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        if (upstream.headers['content-length'])
          res.setHeader('Content-Length', upstream.headers['content-length']);
        res.statusCode = upstream.statusCode;
        return upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      return res.end(err.message);
    }
  }

  // ── /api/sub  (subtitle proxy + SRT→VTT) ────────────────────────────────
  if (route === '/api/sub' || route === '/api/sub/') {
    if (!q.url) return json(400, { error: 'Missing required parameter: url' });
    const url = decodeURIComponent(q.url);
    try {
      const upstream = await fetchUpstream(url);
      const chunks   = [];
      for await (const chunk of upstream) chunks.push(chunk);
      let body = Buffer.concat(chunks).toString('utf8');

      const ct    = (upstream.headers['content-type'] || '').toLowerCase();
      const isSrt = !ct.includes('vtt') &&
                    (url.includes('.srt') || /^\d+\r?\n\d{2}:\d{2}/.test(body.trim()));
      if (isSrt) body = srtToVtt(body);

      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return res.end(body);
    } catch (err) {
      res.statusCode = 502;
      return res.end(err.message);
    }
  }

  // ── 404 for anything else ────────────────────────────────────────────────
  return json(404, {
    error: 'Not found',
    routes: {
      'GET /api/stream': { params: 'id (required), s (season), e (episode)' },
      'GET /api/hls':    { params: 'url (encoded M3U8/segment URL)' },
      'GET /api/sub':    { params: 'url (encoded subtitle URL)' },
    },
  });
};