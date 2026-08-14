// Watches network traffic for media requests and remembers the headers that made
// them work, so a URL that only exists once a player has initialised can be sent
// to YoutubeDL-Material along with its session context.
//
// Why an extension rather than page scripting: these listeners run in the
// extension's own process. Page JavaScript cannot see or interfere with them, so
// the anti-devtools tricks some sites use (debugger traps, console.clear loops,
// key interception) have nothing to act on.
//
// Three signals are combined, because no single one identifies the right URL:
//   * onBeforeSendHeaders - Cookie, Referer, User-Agent (request side)
//   * onHeadersReceived   - Content-Type, Content-Length (response side only)
//   * filterResponseData  - the manifest body, to tell master from media playlist
// plus page metadata from the content script for a usable video name.

const MEDIA_CONTENT_TYPES = /^(?:video\/|audio\/|application\/(?:x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|f4m|smil))/i;

const MEDIA_PATH = /\.(?:mp4|m4v|webm|mkv|mov|avi|flv|mpg|mpeg|ogv|wmv|3gp|m3u8|mpd|mp3|m4a|aac|ogg|opus|flac|wav)(?:$|\?)/i;

// Segments of an HLS/DASH stream. A single playback fires hundreds and none is
// individually useful - yt-dlp wants the manifest.
//
// .aac is deliberately absent from the bare list: it is a valid standalone audio
// file as well as a segment extension, so segment-ness needs a numeric sequence.
const SEGMENT_PATH = /\.(?:ts|m4s|vtt|key)(?:$|\?)|[-_/](?:seg(?:ment)?)?\d{2,6}\.(?:ts|m4s|aac)(?:$|\?)/i;

const MANIFEST_PATH = /\.(?:m3u8|mpd)(?:$|\?)/i;

const QUERY_ENDPOINT = /\.(?:php|aspx?|jsp|cgi|do|ashx)\?[^]*?(?:file|video|url|src|path|media|stream|key)=/i;

const MAX_CAPTURES_PER_TAB = 40;
const MIN_INTERESTING_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_ROWS = 400;
// Manifests are text and small. Anything larger is not a playlist and is left
// alone rather than buffered.
const MAX_MANIFEST_BYTES = 512 * 1024;
// How recently segments must have arrived for a stream to count as playing.
const PLAYING_WINDOW_MS = 8000;

// tabId -> {captures, segmentCount, diagnostics, lastSegmentAt, metadata}
const tabState = new Map();
const pendingRequests = new Map();

function headerValue(headers, name) {
    if (!headers) return null;
    const wanted = name.toLowerCase();
    const found = headers.find(h => h.name && h.name.toLowerCase() === wanted);
    return found ? found.value : null;
}

function stateFor(tabId) {
    if (!tabState.has(tabId)) {
        tabState.set(tabId, {
            captures: new Map(),
            segmentCount: 0,
            diagnostics: [],
            lastSegmentAt: 0,
            metadata: null
        });
    }
    return tabState.get(tabId);
}

function updateBadge(tabId) {
    const state = tabState.get(tabId);
    const count = state ? state.captures.size : 0;
    browser.action.setBadgeText({tabId: tabId, text: count ? String(count) : ''});
    browser.action.setBadgeBackgroundColor({tabId: tabId, color: '#1976d2'});
}

function recordDiagnostic(state, details, contentType, contentLength, verdict) {
    state.diagnostics.push({
        url: details.url,
        resource_type: details.type,
        content_type: contentType || null,
        content_length: contentLength,
        status: details.statusCode,
        verdict: verdict
    });
    if (state.diagnostics.length > MAX_DIAGNOSTIC_ROWS) state.diagnostics.shift();
}

// ---------------------------------------------------------------------------
// Manifest classification
// ---------------------------------------------------------------------------
// A master playlist lists variants (#EXT-X-STREAM-INF); a media playlist lists
// segments (#EXTINF). Only the URL is visible before the body arrives, and the
// two look identical, so the body is what distinguishes them - and the master is
// almost always the right thing to hand to yt-dlp.
function classifyHls(text) {
    if (!/^\s*#EXTM3U/.test(text)) return null;

    const variants = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
        const resolution = (line.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || null;
        // AVERAGE-BANDWIDTH is the representative figure and BANDWIDTH the peak.
        // Matched separately and in that order of preference, because a single
        // optional-prefix pattern picks whichever appears first in the attribute
        // list and would therefore vary by site. The leading delimiter stops
        // BANDWIDTH from matching the tail of AVERAGE-BANDWIDTH.
        const average = (line.match(/AVERAGE-BANDWIDTH=(\d+)/i) || [])[1];
        const peak = (line.match(/[,:]BANDWIDTH=(\d+)/i) || [])[1];
        const bandwidth = average || peak;
        variants.push({
            resolution: resolution,
            bandwidth: bandwidth ? Number(bandwidth) : null,
            uri: (lines[i + 1] || '').trim() || null
        });
    }

    if (variants.length > 0) {
        return {kind: 'master', variants: variants, segment_count: null, segment_uris: [], is_subtitles: false};
    }

    // A media playlist lists its own segments. Keeping the first few is what makes
    // per-stream attribution possible later: when a segment request arrives, the
    // playlist whose segment path it matches is the one actually playing. Without
    // this, "playing" can only be a per-tab guess, which lights up every manifest
    // on a page that has several.
    const segment_uris = [];
    for (let i = 0; i < lines.length && segment_uris.length < 3; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        segment_uris.push(line);
    }

    // Total running time, summed from the per-segment durations. A manifest never
    // states a byte size, so this plus the variant bitrate from the master is the
    // only way to estimate one - and without an estimate Material cannot show any
    // progress at all for a stream.
    let total_duration = 0;
    for (const line of lines) {
        const match = line.match(/^#EXTINF:\s*([\d.]+)/);
        if (match) total_duration += parseFloat(match[1]) || 0;
    }

    // Subtitle renditions are structurally identical to video ones but their
    // segments are .vtt/.srt. Worth distinguishing: handing one to yt-dlp gets you
    // a subtitle file named like a video.
    const is_subtitles = segment_uris.length > 0 &&
        segment_uris.every(uri => /\.(?:vtt|srt|ttml)(?:$|\?)/i.test(uri));

    return {
        kind: 'media',
        variants: [],
        segment_count: (text.match(/#EXTINF/g) || []).length,
        segment_uris: segment_uris,
        is_subtitles: is_subtitles,
        total_duration: total_duration || null
    };
}

function classifyDash(text) {
    if (!/<MPD[\s>]/i.test(text)) return null;
    const representations = [...text.matchAll(/<Representation\b[^>]*>/gi)].map(match => {
        const tag = match[0];
        const width = (tag.match(/\bwidth="(\d+)"/i) || [])[1];
        const height = (tag.match(/\bheight="(\d+)"/i) || [])[1];
        const bandwidth = (tag.match(/\bbandwidth="(\d+)"/i) || [])[1];
        return {
            resolution: width && height ? `${width}x${height}` : null,
            bandwidth: bandwidth ? Number(bandwidth) : null,
            uri: null
        };
    });
    // An MPD is self-contained: it already describes every representation, so it
    // is the equivalent of a master playlist.
    const title = (text.match(/<Title>([^<]{1,200})<\/Title>/i) || [])[1] || null;
    return {kind: 'master', variants: representations, segment_count: null, manifest_title: title};
}

// Reads a manifest body without disturbing it.
//
// Every chunk is written straight back through the filter before anything else
// happens. If parsing threw and the data were not passed through, the player would
// receive a truncated manifest and playback would break - so the pass-through is
// unconditional and comes first.
function attachManifestReader(details) {
    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        return;   // filtering unavailable; classification is optional
    }

    const decoder = new TextDecoder('utf-8');
    let text = '';
    let bytes = 0;

    filter.ondata = event => {
        filter.write(event.data);            // always first, always unconditional
        if (bytes < MAX_MANIFEST_BYTES) {
            bytes += event.data.byteLength;
            try {
                text += decoder.decode(event.data, {stream: true});
            } catch (e) {
                // Binary body after all - stop accumulating, keep passing through.
                bytes = MAX_MANIFEST_BYTES;
            }
        }
    };

    filter.onstop = () => {
        filter.disconnect();
        if (details.tabId < 0 || !text) return;
        let classification = null;
        try {
            classification = classifyHls(text) || classifyDash(text);
        } catch (e) {
            classification = null;
        }
        if (!classification) return;

        const state = stateFor(details.tabId);
        const capture = state.captures.get(details.url);
        if (capture) {
            capture.playlist_kind = classification.kind;
            capture.variants = classification.variants;
            capture.segment_count = classification.segment_count;
            capture.is_subtitles = !!classification.is_subtitles;
            capture.total_duration = classification.total_duration || null;
            if (classification.manifest_title && !capture.manifest_title) {
                capture.manifest_title = classification.manifest_title;
            }

            // Resolve the directory the segments live in. Segment requests are
            // matched against this to attribute playback to one stream rather
            // than badging every manifest on the page.
            if (classification.segment_uris && classification.segment_uris.length > 0) {
                try {
                    const resolved = new URL(classification.segment_uris[0], details.url);
                    resolved.search = '';
                    capture.segment_prefix = resolved.href.slice(0, resolved.href.lastIndexOf('/') + 1);
                } catch (e) {
                    capture.segment_prefix = null;
                }
            }

            // Resolved variant URL paired with its declared bitrate. Both halves
            // are needed later: the URL to tell whether a variant is the one
            // playing, and the bitrate to size a stream that states no byte count.
            // Kept as pairs rather than two arrays so they cannot fall out of step
            // when a variant has no URI.
            if (classification.kind === 'master') {
                capture.variant_links = classification.variants
                    .map(variant => {
                        if (!variant.uri) return null;
                        try {
                            return {
                                url: new URL(variant.uri, details.url).href,
                                bandwidth: variant.bandwidth || null,
                                resolution: variant.resolution || null
                            };
                        } catch (e) {
                            return null;
                        }
                    })
                    .filter(Boolean);
            }
        }
    };

    filter.onerror = () => {
        // Nothing to recover; the response itself is unaffected.
    };
}

browser.webRequest.onBeforeRequest.addListener(
    details => {
        // Filter only URLs that look like a playlist. Attaching to everything
        // would put the extension in the path of all traffic for no benefit.
        if (details.tabId >= 0 && MANIFEST_PATH.test(details.url)) {
            attachManifestReader(details);
        }
        return {};
    },
    {urls: ['<all_urls>']},
    ['blocking']
);

browser.webRequest.onBeforeSendHeaders.addListener(
    details => {
        if (details.tabId < 0) return;
        // Firefox includes Cookie in requestHeaders with no extra opt-in.
        // (Chrome needs "extraHeaders"; that option does not exist here.)
        pendingRequests.set(details.requestId, {
            cookie: headerValue(details.requestHeaders, 'Cookie'),
            referer: headerValue(details.requestHeaders, 'Referer'),
            user_agent: headerValue(details.requestHeaders, 'User-Agent')
        });
        if (pendingRequests.size > 800) {
            pendingRequests.delete(pendingRequests.keys().next().value);
        }
    },
    {urls: ['<all_urls>']},
    ['requestHeaders']
);

browser.webRequest.onHeadersReceived.addListener(
    details => {
        const request = pendingRequests.get(details.requestId);
        pendingRequests.delete(details.requestId);
        if (details.tabId < 0) return;

        const contentType = (headerValue(details.responseHeaders, 'Content-Type') || '').split(';')[0].trim();
        const lengthHeader = headerValue(details.responseHeaders, 'Content-Length');
        const contentLength = lengthHeader ? Number(lengthHeader) : null;
        const url = details.url;
        const state = stateFor(details.tabId);

        const isManifest = MANIFEST_PATH.test(url) || /mpegurl|dash\+xml/i.test(contentType);
        const isSegment = !isManifest && SEGMENT_PATH.test(url);

        if (isSegment) {
            state.segmentCount++;
            state.lastSegmentAt = Date.now();

            // Attribute this segment to the playlist that listed it. This is the
            // signal behind "playing now": segments keep arriving for as long as
            // playback continues, and the directory they come from identifies
            // which stream. A page-wide timestamp alone would mark every manifest
            // as playing, which is what it used to do.
            const bare = url.split('?')[0];
            for (const candidate of state.captures.values()) {
                if (candidate.segment_prefix && bare.startsWith(candidate.segment_prefix)) {
                    candidate.lastSegmentAt = Date.now();
                    break;
                }
            }

            recordDiagnostic(state, details, contentType, contentLength, 'segment (suppressed)');
            return;
        }

        const isMediaResourceType = details.type === 'media';

        const looksMedia = MEDIA_CONTENT_TYPES.test(contentType) ||
                           MEDIA_PATH.test(url) ||
                           QUERY_ENDPOINT.test(url) ||
                           isMediaResourceType ||
                           (/^(?:application|binary)\/octet-stream/i.test(contentType) &&
                            (contentLength === null || contentLength >= MIN_INTERESTING_BYTES));
        if (!looksMedia) {
            recordDiagnostic(state, details, contentType, contentLength, 'not media');
            return;
        }

        if (contentLength !== null && contentLength < MIN_INTERESTING_BYTES && !isManifest && !isMediaResourceType) {
            recordDiagnostic(state, details, contentType, contentLength, 'too small');
            return;
        }

        recordDiagnostic(state, details, contentType, contentLength, 'CAPTURED');

        const existing = state.captures.get(url);
        const capture = {
            url: url,
            content_type: contentType || null,
            content_length: contentLength,
            status: details.statusCode,
            is_manifest: isManifest,
            // Filled in later by the manifest reader, which finishes after this.
            playlist_kind: existing ? existing.playlist_kind : null,
            variants: existing ? existing.variants : null,
            segment_count: existing ? existing.segment_count : null,
            manifest_title: existing ? existing.manifest_title : null,
            cookie: request ? request.cookie : null,
            referer: request ? request.referer : null,
            user_agent: request ? request.user_agent : null,
            source_page_url: existing ? existing.source_page_url : null,
            page_title: existing ? existing.page_title : null,
            captured_at: Date.now()
        };

        // Page URL and title at capture time. Deliberately not cleared on
        // navigation: a site that reloads itself defensively would otherwise wipe
        // everything captured so far.
        browser.tabs.get(details.tabId).then(tab => {
            capture.source_page_url = tab && tab.url ? tab.url : null;
            capture.page_title = tab && tab.title ? tab.title : null;
            state.captures.set(url, capture);
            if (state.captures.size > MAX_CAPTURES_PER_TAB) {
                state.captures.delete(state.captures.keys().next().value);
            }
            updateBadge(details.tabId);
        }, () => {
            state.captures.set(url, capture);
            updateBadge(details.tabId);
        });
    },
    {urls: ['<all_urls>']},
    ['responseHeaders']
);

browser.tabs.onRemoved.addListener(tabId => tabState.delete(tabId));

// Approximate byte size of a stream, from its running time and declared bitrate.
//
// Neither an HLS manifest nor its format entries state a byte count, so without
// this Material has no denominator and shows no progress at all for a captured
// stream. The result is an estimate - bitrate is a ceiling and real content sits
// below it - so it typically runs high, meaning progress reaches 100% slightly
// early. That is still far more useful than a bar that never moves.
//
// Duration is per-content so any rendition's value works; bitrate has to come from
// the master's declaration for the rendition yt-dlp will actually pick.
function estimateStreamBytes(capture, allCaptures) {
    if (!capture.is_manifest || capture.is_subtitles) return null;

    let duration = capture.total_duration || null;
    let bandwidth = null;

    if (capture.playlist_kind === 'master' && capture.variant_links) {
        // yt-dlp defaults to the best format, so size against the top bitrate.
        bandwidth = capture.variant_links.reduce(
            (best, link) => (link.bandwidth && link.bandwidth > best ? link.bandwidth : best), 0) || null;
        if (!duration) {
            for (const link of capture.variant_links) {
                const variant = allCaptures.find(other => other.url === link.url && other.total_duration);
                if (variant) { duration = variant.total_duration; break; }
            }
        }
    } else if (capture.playlist_kind === 'media') {
        // Find the master that lists this rendition and take its declared bitrate.
        for (const other of allCaptures) {
            if (!other.variant_links) continue;
            const link = other.variant_links.find(entry => entry.url === capture.url);
            if (link && link.bandwidth) { bandwidth = link.bandwidth; break; }
        }
    }

    if (!duration || !bandwidth) return null;
    return Math.round((bandwidth / 8) * duration);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
async function sendToMaterial(capture, metadata) {
    const settings = await browser.storage.local.get(['materialUrl', 'apiKey']);
    const base = (settings.materialUrl || '').replace(/\/+$/, '');
    if (!base) return {success: false, error: 'Set the YTDL-Material URL in the extension options first.'};
    if (!settings.apiKey) return {success: false, error: 'Set the API key in the extension options first.'};

    // The app's API middleware authenticates on ?apiKey=, so no separate secret.
    const endpoint = `${base}/api/capture?apiKey=${encodeURIComponent(settings.apiKey)}`;

    // Title preference: the page's own video metadata beats the tab title, which
    // often carries site branding, which in turn beats anything derivable from a
    // signed CDN URL (nothing).
    const title = (metadata && metadata.title) || capture.manifest_title || capture.page_title || null;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                url: capture.url,
                referer: capture.referer,
                cookie: capture.cookie,
                user_agent: capture.user_agent,
                source_page_url: capture.source_page_url,
                page_title: title,
                thumbnail_url: (metadata && metadata.thumbnail) || null,
                content_type: capture.content_type,
                // Lets Material show real progress for a progressive file.
                content_length: capture.content_length || null,
                // For a stream there is no Content-Length, so this bitrate-based
                // estimate is the only available denominator. Sent separately so
                // the backend can log that the progress figure is approximate.
                estimated_size: capture.estimated_size || null,
                type: 'video'
            })
        });
        if (response.status === 404) {
            return {success: false, error: 'Material has no /api/capture endpoint - that instance is not running a build of this fork.'};
        }
        if (!response.ok) {
            return {success: false, error: `Material returned HTTP ${response.status}. Check the URL and API key.`};
        }
        const body = await response.json();
        return body && body.success
            ? {
                success: true,
                download_uid: body.download_uid,
                preauthorised_extension: !!body.preauthorised_extension
            }
            : {success: false, error: (body && body.error) || 'Material rejected the capture.'};
    } catch (e) {
        // Do not report this as purely connectivity. Material's API middleware
        // answers an unauthenticated /api/ request by closing the socket rather
        // than returning 401, so a wrong key looks identical to a dead host.
        return {
            success: false,
            error: `No response from Material (${e.message}). Three things look identical here: the URL is ` +
                   `unreachable, the API key is wrong (a bad key closes the connection instead of returning an ` +
                   `error), or Firefox rewrote the request to HTTPS against a plain-HTTP server. Use "Test only" ` +
                   `in the extension options - it distinguishes them.`
        };
    }
}

// Connection test
// ---------------------------------------------------------------------------
// fetch() collapses every transport failure into "NetworkError when attempting
// to fetch resource", which hides the three causes that actually happen here:
// the host is unreachable, the API key was rejected (Material closes the socket
// instead of returning 401), or Firefox rewrote the request to HTTPS against a
// plain-HTTP server. webRequest sees what fetch will not - the real nsresult and
// the URL as it actually went out - so the test watches its own request.
async function testConnection(base, apiKey) {
    const observed = [];
    const record = details => observed.push(details);

    // Match patterns cannot carry a port, and a pattern containing one is rejected
    // outright - so filter on the host and let it cover every port. The scheme is
    // wildcarded deliberately: catching the https rewrite is the entire point, so
    // restricting this to the scheme we asked for would filter out the evidence.
    let filter = null;
    try {
        filter = {urls: [`*://${new URL(base).hostname}/*`]};
    } catch (e) {
        filter = null;
    }

    let watching = false;
    if (filter) {
        try {
            browser.webRequest.onErrorOccurred.addListener(record, filter);
            watching = true;
        } catch (e) {
            // Not fatal - we just lose the precise diagnosis and fall back to
            // fetch's own message.
        }
    }

    // A scheme rewrite is the one failure that survives a correct URL and a
    // correct key, so name it explicitly rather than lumping it in with the rest.
    const upgraded = () => observed.find(d => /^https:/i.test(d.url)) && /^http:/i.test(base);
    const nsResult = () => {
        const hit = observed.find(d => d.error);
        return hit ? hit.error : null;
    };
    const finish = result => {
        if (watching) browser.webRequest.onErrorOccurred.removeListener(record);
        return result;
    };

    // Stage 1: reachability, with no key involved. Anything outside /api/ is
    // unauthenticated, so a 200 here isolates transport from authentication -
    // which is what makes a stage 2 failure meaningfully attributable to the key.
    try {
        const root = await fetch(`${base}/`, {method: 'GET', cache: 'no-store'});
        if (!root.ok) {
            return finish({success: false, error: `Reached ${base} but it returned HTTP ${root.status}. Is that a YTDL-Material instance?`});
        }
    } catch (e) {
        if (upgraded()) {
            return finish({
                success: false,
                error: `Firefox sent this to HTTPS even though the URL is http:// - the server answered in plain HTTP, so the ` +
                       `handshake failed (${nsResult() || e.message}). In about:config set dom.security.https_first and ` +
                       `dom.security.https_first_pbm to false, or the equivalent _for_local_addresses pref.`
            });
        }
        return finish({
            success: false,
            error: `Could not reach ${base} (${nsResult() || e.message}). Check the IP and port - the port must match the one ` +
                   `the container publishes, not Material's internal 17442.`
        });
    }

    // Stage 2: the key, and whether this build even has the endpoint. An empty
    // body is deliberate: validation rejects it only after the API middleware has
    // accepted the key, so a 400 proves authentication passed without creating
    // anything. A closed socket here - now that stage 1 has proven the host is up
    // - means the key was refused.
    observed.length = 0;
    try {
        const probe = await fetch(`${base}/api/capture?apiKey=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: '{}'
        });
        if (probe.status === 404) {
            return finish({success: false, error: `Reached Material, but it has no /api/capture endpoint - that instance is not running a build of this fork.`});
        }
        // 400 is the expected, healthy answer to an empty body.
        if (probe.status === 400) {
            return finish({success: true, message: 'Connected. URL and API key both accepted.'});
        }
        if (probe.ok) {
            return finish({success: true, message: 'Connected, though the probe was accepted rather than rejected - unexpected but harmless.'});
        }
        return finish({success: false, error: `Material returned HTTP ${probe.status} to the test request.`});
    } catch (e) {
        return finish({
            success: false,
            error: `${base} is reachable, but the API request was refused (${nsResult() || e.message}). That is what a rejected ` +
                   `API key looks like - Material closes the connection instead of returning 401. Check the key, and that ` +
                   `"Use API key" is enabled in Material's settings.`
        });
    }
}

browser.runtime.onMessage.addListener(async (message, sender) => {
    if (message.action === 'testConnection') {
        return await testConnection(message.base, message.apiKey);
    }
    if (message.action === 'pageMetadata') {
        // Only the top-level frame's metadata is trusted for the title; an iframed
        // player would otherwise overwrite it with the embed's own page data.
        if (sender.tab && sender.frameId === 0) {
            const state = stateFor(sender.tab.id);
            state.metadata = message.metadata;
        }
        return {success: true};
    }
    if (message.action === 'getCaptures') {
        const state = tabState.get(message.tabId);
        if (!state) return {captures: [], segmentCount: 0, playing: false, metadata: null};

        const now = Date.now();
        const isActive = capture => !!capture.lastSegmentAt && (now - capture.lastSegmentAt) < PLAYING_WINDOW_MS;
        const all = [...state.captures.values()];

        const captures = all.map(capture => {
            // A media playlist is playing when its own segments are still arriving.
            // A master is playing when any variant it lists is - the variant is what
            // the player actually requests, but the master is what you want to send.
            let playing = isActive(capture);
            if (!playing && capture.variant_links) {
                playing = capture.variant_links.some(link => {
                    const variant = all.find(other => other.url === link.url);
                    return variant ? isActive(variant) : false;
                });
            }
            return {...capture, is_playing: playing, estimated_size: estimateStreamBytes(capture, all)};
        });

        // Order by what you would actually want to send: a playing master beats a
        // playing rendition, which beats anything idle. Subtitles go last - they
        // are structurally a valid stream but never the thing being asked for.
        captures.sort((a, b) => {
            const rank = capture => (capture.is_subtitles ? 8 : 0) +
                                    (capture.is_playing ? 0 : 4) +
                                    (capture.playlist_kind === 'master' ? 0 : 2);
            return rank(a) - rank(b) || b.captured_at - a.captured_at;
        });

        return {
            captures: captures,
            segmentCount: state.segmentCount,
            playing: now - state.lastSegmentAt < PLAYING_WINDOW_MS,
            metadata: state.metadata
        };
    }
    if (message.action === 'getDiagnostics') {
        const state = tabState.get(message.tabId);
        return {diagnostics: state ? state.diagnostics.slice().reverse() : []};
    }
    if (message.action === 'clearCaptures') {
        const state = tabState.get(message.tabId);
        const metadata = state ? state.metadata : null;
        tabState.delete(message.tabId);
        // Keep the page metadata: it describes the page, not the captures, and
        // re-scraping needs another content-script event.
        if (metadata) stateFor(message.tabId).metadata = metadata;
        updateBadge(message.tabId);
        return {success: true};
    }
    if (message.action === 'sendToMaterial') {
        const state = tabState.get(message.tabId);
        return await sendToMaterial(message.capture, state ? state.metadata : null);
    }
    return {success: false, error: `Unknown action ${message.action}`};
});
