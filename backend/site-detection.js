// Piece 1 of the site-detection project: a lightweight, browser-free fallback
// for pages yt-dlp's generic extractor cannot handle.
//
// Invoked ONLY after a normal yt-dlp call has already failed with
// "Unsupported URL" - never on the successful path, so ordinary downloads pay
// no latency for it.
//
// What it does: fetch the page, parse it with Cheerio (no JS execution), look
// for media in the DOM and in the raw HTML, and - if that finds nothing - scan
// the page's linked JS bundles, which is a real gap in yt-dlp's generic
// extractor. Returns a ranked candidate list; it never picks for you.
//
// What it deliberately does not do: execute JavaScript, or guess at Referer and
// Cookie values. A site needing a real session is a Piece 2 case and is reported
// as such rather than fumbled at here.
//
// Note on dependencies: cheerio is pinned to 1.0.0-rc.12 because 1.0.0+ requires
// Node >= 18.17 and the app image runs Node 16.14.2.

const cheerio = require('cheerio');
const axios = require('axios');
const dns = require('dns');
const net = require('net');
const url_parser = require('url');

const logger = require('./logger');
const config_api = require('./config.js');
const CONSTS = require('./consts');

// ---------------------------------------------------------------------------
// Limits. This runs on a NAS, against pages chosen by whatever URL was pasted
// in, so every fetch is bounded in size, time and count.
// ---------------------------------------------------------------------------
const LIMITS = {
    page_bytes: 5 * 1024 * 1024,     // a 5MB HTML document is already absurd
    script_bytes: 2 * 1024 * 1024,   // per linked JS file
    total_script_bytes: 12 * 1024 * 1024,
    max_scripts: 8,                  // bundles are big; a handful is plenty
    redirects: 5,
    timeout_ms: 15000,
    probe_timeout_ms: 10000,
    max_candidates: 25
};

// Extensions that look like media in a URL path. Used ONLY to rank and label
// candidates - never to decide whether writing a file is safe. That decision is
// yt-dlp's, and we read it back from its own error output instead of trying to
// mirror its allowlist here (which contains computed entries and would drift).
const MEDIA_PATH_EXTENSIONS = new Set([
    'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'mpg', 'mpeg', 'ogv', 'wmv', '3gp',
    'm3u8', 'mpd', 'f4m', 'ism', 'smil',
    'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav', 'weba'
]);

// Streaming manifests are usually the right answer when present, so they rank
// above a progressive file, which ranks above a bare guess from a JS bundle.
const CONFIDENCE = {
    dom_source: 90,
    manifest: 85,
    dom_video: 80,
    html_media_url: 60,
    embed_iframe: 55,
    html_query_endpoint: 45,
    script_media_url: 35,
    script_query_endpoint: 25
};

const EMBED_HOST_PATTERNS = [
    {name: 'youtube', re: /(?:youtube\.com\/embed|youtube-nocookie\.com\/embed|youtu\.be)\//i},
    {name: 'vimeo', re: /player\.vimeo\.com\/video\//i},
    {name: 'dailymotion', re: /dailymotion\.com\/(?:embed|video)\//i},
    {name: 'jwplayer', re: /(?:cdn\.jwplayer\.com|content\.jwplatform\.com)\//i},
    {name: 'kaltura', re: /(?:kaltura\.com|kaltura\.nu)\/(?:p|partner_id)\//i},
    {name: 'brightcove', re: /players\.brightcove\.net\//i},
    {name: 'wistia', re: /(?:fast\.wistia\.(?:net|com))\//i},
    {name: 'streamable', re: /streamable\.com\//i},
    {name: 'bitchute', re: /bitchute\.com\/embed\//i},
    {name: 'rumble', re: /rumble\.com\/embed\//i}
];

// ---------------------------------------------------------------------------
// SSRF guards
// ---------------------------------------------------------------------------
// This module fetches URLs the user supplied, and then fetches URLs discovered
// inside that content - a step further from user intent. A NAS typically sits on
// a LAN with a router, a DNS server and its own admin UI all reachable, so both
// hops are checked.

function isBlockedAddress(address) {
    if (!address) return true;
    if (net.isIPv4(address)) {
        const p = address.split('.').map(Number);
        if (p[0] === 10) return true;                                   // 10.0.0.0/8
        if (p[0] === 127) return true;                                  // loopback
        if (p[0] === 169 && p[1] === 254) return true;                  // link-local + cloud metadata
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;      // 172.16.0.0/12
        if (p[0] === 192 && p[1] === 168) return true;                  // 192.168.0.0/16
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;     // CGNAT
        if (p[0] === 0 || p[0] >= 224) return true;                     // this-network, multicast, reserved
        return false;
    }
    if (net.isIPv6(address)) {
        const a = address.toLowerCase();
        if (a === '::1' || a === '::') return true;
        if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
        // IPv4-mapped, e.g. ::ffff:192.168.1.1
        const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isBlockedAddress(mapped[1]);
        return false;
    }
    return true;
}

// Escape hatch for local development only: lets detection reach private
// addresses so a test page can be served from localhost. Deliberately an
// environment variable rather than a config item, so it cannot be switched on
// from the web UI - a GUI toggle here would be an SSRF switch.
const ALLOW_PRIVATE = process.env.SITE_DETECTION_ALLOW_PRIVATE === 'true';
if (ALLOW_PRIVATE) {
    logger.warn('site-detection: SITE_DETECTION_ALLOW_PRIVATE=true - private and loopback addresses are reachable. Development only; never set this on the NAS.');
}

// Resolves the hostname and rejects if ANY answer is private. Not full
// protection against DNS rebinding (that needs connection-level IP pinning),
// but it stops the straightforward cases and is re-checked on every redirect.
async function assertPublicUrl(target) {
    let parsed;
    try {
        parsed = new URL(target);
    } catch (e) {
        throw new Error(`Not a valid URL: ${target}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Refusing non-HTTP(S) URL: ${parsed.protocol}`);
    }

    if (ALLOW_PRIVATE) return parsed;

    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
        if (isBlockedAddress(host)) throw new Error(`Refusing private/loopback address: ${host}`);
        return parsed;
    }

    let answers;
    try {
        answers = await dns.promises.lookup(host, {all: true});
    } catch (e) {
        throw new Error(`Could not resolve ${host}`);
    }
    for (const answer of answers) {
        if (isBlockedAddress(answer.address)) {
            throw new Error(`Refusing ${host}: resolves to private/loopback address ${answer.address}`);
        }
    }
    return parsed;
}

// The VPN toggle only rewires yt-dlp. Without this, detection would run from the
// NAS's own IP while the download ran through the tunnel - different geo, and
// potentially different page content than what actually gets downloaded.
function proxyConfig() {
    if (!config_api.getConfigItem('ytdl_vpn_proxy_enabled')) return false;
    const raw = config_api.getConfigItem('ytdl_vpn_proxy_url');
    if (!raw) return false;
    try {
        const parsed = new URL(raw);
        return {
            protocol: parsed.protocol.replace(':', ''),
            host: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : 8888
        };
    } catch (e) {
        logger.warn(`site-detection: ignoring unparseable VPN proxy URL '${raw}'`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
// Redirects are followed by hand, one hop at a time, so each new location can be
// re-validated. axios' own redirect handling would jump straight to a private
// address without us ever seeing it.
async function guardedGet(target, {maxBytes, referer = null, extraHeaders = {}} = {}) {
    let current = target;

    for (let hop = 0; hop <= LIMITS.redirects; hop++) {
        await assertPublicUrl(current);

        const response = await axios.get(current, {
            timeout: LIMITS.timeout_ms,
            // Redirects are handled here, one hop at a time, so each new
            // location goes back through assertPublicUrl.
            maxRedirects: 0,
            maxContentLength: maxBytes,
            maxBodyLength: maxBytes,
            responseType: 'text',
            transformResponse: [(data) => data],
            proxy: proxyConfig(),
            // Nothing throws on status; 3xx and 4xx are inspected below.
            validateStatus: () => true,
            headers: Object.assign({
                'User-Agent': CONSTS.SITE_DETECTION_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }, referer ? {'Referer': referer} : {}, extraHeaders)
        });

        const status = response.status;
        if (status >= 300 && status < 400 && response.headers && response.headers.location) {
            current = new URL(response.headers.location, current).href;
            continue;
        }
        if (status >= 400) {
            const error = new Error(`HTTP ${status} fetching ${current}`);
            error.status = status;
            error.final_url = current;
            throw error;
        }
        return {body: typeof response.data === 'string' ? response.data : String(response.data || ''),
                final_url: current,
                headers: response.headers || {}};
    }
    throw new Error(`Too many redirects fetching ${target}`);
}

// HEAD first, then a 1-byte ranged GET if HEAD is unsupported (common on the
// query-string endpoints this whole feature exists for). The Content-Type it
// returns is the evidence shown in the extension warning prompt.
async function probeCandidate(candidateUrl, referer = null) {
    const result = {url: candidateUrl, ok: false, status: null, content_type: null,
                    content_length: null, final_url: candidateUrl, error: null};
    const headers = Object.assign(
        {'User-Agent': CONSTS.SITE_DETECTION_USER_AGENT},
        referer ? {'Referer': referer} : {});

    try {
        await assertPublicUrl(candidateUrl);
    } catch (e) {
        result.error = e.message;
        return result;
    }

    for (const attempt of ['head', 'range']) {
        let current = candidateUrl;
        try {
            // Redirects are followed by hand here too. Letting axios follow them
            // would skip the SSRF check on every hop after the first, and a
            // redirect to 169.254.169.254 is exactly what that check is for.
            for (let hop = 0; hop <= LIMITS.redirects; hop++) {
                await assertPublicUrl(current);
                const response = await axios({
                    method: attempt === 'head' ? 'head' : 'get',
                    url: current,
                    timeout: LIMITS.probe_timeout_ms,
                    maxRedirects: 0,
                    validateStatus: () => true,
                    proxy: proxyConfig(),
                    responseType: 'text',
                    transformResponse: [(data) => data],
                    headers: attempt === 'range' ? Object.assign({'Range': 'bytes=0-0'}, headers) : headers
                });

                if (response.status >= 300 && response.status < 400 && response.headers && response.headers.location) {
                    current = new URL(response.headers.location, current).href;
                    continue;
                }

                result.status = response.status;
                result.final_url = current;
                if (response.status >= 400) throw new Error(`HTTP ${response.status}`);

                result.ok = true;
                result.content_type = (response.headers['content-type'] || '').split(';')[0].trim() || null;
                const length = response.headers['content-length'];
                if (attempt === 'head' && length) result.content_length = Number(length);
                const range = response.headers['content-range'];
                if (range) {
                    const total = range.split('/')[1];
                    if (total && total !== '*') result.content_length = Number(total);
                }
                return result;
            }
            throw new Error('Too many redirects');
        } catch (e) {
            result.error = e.message;
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
function pathExtension(candidateUrl) {
    try {
        const pathname = new URL(candidateUrl).pathname;
        const last = pathname.split('/').pop() || '';
        if (!last.includes('.')) return null;
        return last.split('.').pop().toLowerCase() || null;
    } catch (e) {
        return null;
    }
}

function looksLikeMediaPath(candidateUrl) {
    const ext = pathExtension(candidateUrl);
    return !!ext && MEDIA_PATH_EXTENSIONS.has(ext);
}

// Endpoints like remote_control.php?file=... - no media extension in the path,
// but a query string that plainly names a file or stream.
function looksLikeQueryEndpoint(candidateUrl) {
    try {
        const parsed = new URL(candidateUrl);
        if (!parsed.search) return false;
        if (!/\.(?:php|aspx?|jsp|cgi|do|ashx)$/i.test(parsed.pathname) && !/\/(?:get|stream|play|video|media|download)/i.test(parsed.pathname)) {
            return false;
        }
        return /(?:^|[?&])(?:file|video|url|src|path|media|id|v|stream|key)=/i.test(parsed.search);
    } catch (e) {
        return false;
    }
}

function absolutise(candidate, base) {
    try {
        const resolved = new URL(candidate, base).href;
        return resolved.startsWith('http://') || resolved.startsWith('https://') ? resolved : null;
    } catch (e) {
        return null;
    }
}

// Matches absolute and root-relative URLs that end in a media extension, plus
// query-string endpoints. Kept deliberately narrow: a greedy pattern over a
// minified bundle produces mostly noise.
const MEDIA_URL_REGEX = new RegExp(
    '(?:https?:)?//[^\\s"\'<>()\\\\]+?\\.(?:' + [...MEDIA_PATH_EXTENSIONS].join('|') + ')(?:\\?[^\\s"\'<>()\\\\]*)?',
    'gi');
const ROOT_RELATIVE_MEDIA_REGEX = new RegExp(
    '["\'](/[^\\s"\'<>()\\\\]+?\\.(?:' + [...MEDIA_PATH_EXTENSIONS].join('|') + ')(?:\\?[^\\s"\'<>()\\\\]*)?)["\']',
    'gi');
// Leading delimiter only - the trailing [^\s"'<>()\\]* already stops at a quote,
// bracket or whitespace, so no closing delimiter is needed (and requiring one
// would miss URLs that run to the end of a line or attribute).
const QUERY_ENDPOINT_REGEX =
    /["'(\s=]((?:(?:https?:)?\/\/|\/)[^\s"'<>()\\]+?\.(?:php|aspx?|jsp|cgi|do|ashx)\?[^\s"'<>()\\]*(?:file|video|url|src|path|media|stream|key)=[^\s"'<>()\\]*)/gi;

function collectRegexMatches(text, base, origin, out) {
    const push = (raw, kind) => {
        const resolved = absolutise(raw, base);
        if (!resolved) return;
        let confidence;
        if (kind === 'query') {
            confidence = origin === 'script' ? CONFIDENCE.script_query_endpoint : CONFIDENCE.html_query_endpoint;
        } else if (/\.(?:m3u8|mpd)(?:\?|$)/i.test(resolved)) {
            confidence = CONFIDENCE.manifest;
        } else {
            confidence = origin === 'script' ? CONFIDENCE.script_media_url : CONFIDENCE.html_media_url;
        }
        out.push({url: resolved, confidence, found_in: origin, how: kind === 'query' ? 'query-string endpoint' : 'URL in text'});
    };

    let match;
    MEDIA_URL_REGEX.lastIndex = 0;
    while ((match = MEDIA_URL_REGEX.exec(text)) !== null) push(match[0], 'media');
    ROOT_RELATIVE_MEDIA_REGEX.lastIndex = 0;
    while ((match = ROOT_RELATIVE_MEDIA_REGEX.exec(text)) !== null) push(match[1], 'media');
    QUERY_ENDPOINT_REGEX.lastIndex = 0;
    while ((match = QUERY_ENDPOINT_REGEX.exec(text)) !== null) push(match[1], 'query');
}

function scanDom($, base, out) {
    $('video').each((i, el) => {
        const src = $(el).attr('src');
        const resolved = src && absolutise(src, base);
        if (resolved) out.push({url: resolved, confidence: CONFIDENCE.dom_video, found_in: 'html', how: '<video src>'});
    });
    $('video source, audio source').each((i, el) => {
        const src = $(el).attr('src');
        const resolved = src && absolutise(src, base);
        if (resolved) {
            out.push({url: resolved, confidence: CONFIDENCE.dom_source, found_in: 'html',
                      how: '<source>', media_type: $(el).attr('type') || null});
        }
    });
    $('iframe').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        const resolved = src && absolutise(src, base);
        if (!resolved) return;
        const match = EMBED_HOST_PATTERNS.find(p => p.re.test(resolved));
        if (match) {
            out.push({url: resolved, confidence: CONFIDENCE.embed_iframe, found_in: 'html',
                      how: `${match.name} embed`, is_embed: true});
        }
    });
}

function linkedScripts($, base) {
    const urls = [];
    $('script[src]').each((i, el) => {
        const src = $(el).attr('src');
        const resolved = src && absolutise(src, base);
        if (!resolved) return;
        if (/\.map(?:\?|$)/i.test(resolved)) return;                  // source maps are huge and useless here
        if (/(?:analytics|gtag|gtm|facebook|hotjar|recaptcha|adsystem|doubleclick)/i.test(resolved)) return;
        urls.push(resolved);
    });
    return [...new Set(urls)].slice(0, LIMITS.max_scripts);
}

function dedupeAndRank(candidates) {
    const best = new Map();
    for (const candidate of candidates) {
        const existing = best.get(candidate.url);
        if (!existing || candidate.confidence > existing.confidence) best.set(candidate.url, candidate);
    }
    return [...best.values()]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, LIMITS.max_candidates);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// Returns {ok, page_url, final_url, candidates, needs_session, notes}.
// needs_session is the Piece 2 signal: the page itself could not be read, or was
// read but every candidate refuses to serve without real session context.
exports.detectCandidates = async (pageUrl, {probe = true} = {}) => {
    const result = {
        ok: false, page_url: pageUrl, final_url: null,
        candidates: [], needs_session: false, notes: []
    };

    let page;
    try {
        page = await guardedGet(pageUrl, {maxBytes: LIMITS.page_bytes});
    } catch (e) {
        result.notes.push(`Could not fetch the page: ${e.message}`);
        // 401/403 or a redirect to a login page is the classic "needs a real
        // browser session" shape. Say so instead of guessing at credentials.
        if (e.status === 401 || e.status === 403) result.needs_session = true;
        return result;
    }

    result.final_url = page.final_url;
    const $ = cheerio.load(page.body);
    const found = [];

    scanDom($, page.final_url, found);
    collectRegexMatches(page.body, page.final_url, 'html', found);

    if (found.length === 0) {
        // The gap this feature exists for: yt-dlp's generic extractor does not
        // follow linked JS, so a URL sitting in a bundle is invisible to it.
        const scripts = linkedScripts($, page.final_url);
        result.notes.push(`Nothing in the HTML; scanned ${scripts.length} linked script(s).`);
        let budget = LIMITS.total_script_bytes;
        for (const script of scripts) {
            if (budget <= 0) { result.notes.push('Script scan budget exhausted.'); break; }
            try {
                const fetched = await guardedGet(script, {
                    maxBytes: Math.min(LIMITS.script_bytes, budget),
                    referer: page.final_url
                });
                budget -= Buffer.byteLength(fetched.body || '', 'utf8');
                collectRegexMatches(fetched.body, script, 'script', found);
            } catch (e) {
                logger.verbose(`site-detection: skipping script ${script}: ${e.message}`);
            }
        }
    }

    result.candidates = dedupeAndRank(found);
    result.ok = result.candidates.length > 0;

    if (!result.ok) {
        result.notes.push('No media candidates found in the HTML or its linked scripts.');
        result.needs_session = true;
        return result;
    }

    if (probe) {
        for (const candidate of result.candidates) {
            if (candidate.is_embed) continue;   // hand embeds straight to yt-dlp
            const probed = await probeCandidate(candidate.url, page.final_url);
            candidate.probe = probed;
            candidate.content_type = probed.content_type;
            // Evidence for the extension warning prompt: the path says one thing,
            // the server says another.
            candidate.path_extension = pathExtension(candidate.url);
            candidate.looks_like_media_path = looksLikeMediaPath(candidate.url);
            candidate.server_says_media = !!probed.content_type &&
                /^(?:video|audio|application\/(?:x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|octet-stream))/i.test(probed.content_type);
            // A 401/403 on the media itself is the Piece 2 signal for this candidate.
            if (probed.status === 401 || probed.status === 403) candidate.needs_session = true;
        }
        // Confirmed media beats a guess, regardless of where it was found.
        for (const candidate of result.candidates) {
            if (candidate.server_says_media) candidate.confidence += 20;
        }
        result.candidates.sort((a, b) => b.confidence - a.confidence);

        const reachable = result.candidates.filter(c => c.is_embed || (c.probe && c.probe.ok));
        if (reachable.length === 0) {
            result.needs_session = true;
            result.notes.push('Candidates were found but none could be fetched - the site probably needs a real browser session.');
        }
    }

    return result;
};

// Exported for the CLI harness and tests; not part of the pipeline's interface.
exports._internal = {scanDom, collectRegexMatches, dedupeAndRank, linkedScripts, isBlockedAddress};

exports.looksLikeMediaPath = looksLikeMediaPath;
exports.looksLikeQueryEndpoint = looksLikeQueryEndpoint;
exports.pathExtension = pathExtension;
exports.probeCandidate = probeCandidate;
exports.assertPublicUrl = assertPublicUrl;
exports.LIMITS = LIMITS;
