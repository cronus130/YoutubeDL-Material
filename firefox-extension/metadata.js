// Read-only scrape of the page's own video metadata.
//
// Neither the network layer nor an HLS manifest carries a usable video name -
// m3u8 has no title field, and a signed CDN URL has nothing but a token. The page
// almost always does, in one of three places, and the same sources usually give a
// poster image too.
//
// This only reads. It never touches the DOM, so there is nothing for a page to
// observe or interfere with, unlike the element highlighting that was originally
// planned. Page scripts cannot see content-script variables either.

function firstNonEmpty(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

function metaContent(selector) {
    const element = document.querySelector(selector);
    return element ? element.getAttribute('content') : null;
}

// Walks JSON-LD looking for a VideoObject. Sites nest these inside @graph or
// arrays often enough that a recursive search is worth it over a shallow read.
function findVideoObject(node, depth = 0) {
    if (!node || depth > 6) return null;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findVideoObject(item, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (typeof node !== 'object') return null;

    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('VideoObject') && (node.name || node.headline)) return node;

    for (const key of ['@graph', 'video', 'mainEntity', 'itemListElement', 'hasPart']) {
        if (node[key]) {
            const found = findVideoObject(node[key], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function fromJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        let parsed;
        try {
            parsed = JSON.parse(script.textContent);
        } catch (e) {
            continue;   // sites ship malformed JSON-LD constantly
        }
        const video = findVideoObject(parsed);
        if (!video) continue;

        let thumbnail = video.thumbnailUrl || video.thumbnail || video.image;
        if (Array.isArray(thumbnail)) thumbnail = thumbnail[0];
        if (thumbnail && typeof thumbnail === 'object') thumbnail = thumbnail.url || thumbnail.contentUrl;

        return {
            title: firstNonEmpty(video.name, video.headline),
            thumbnail: typeof thumbnail === 'string' ? thumbnail : null,
            duration: typeof video.duration === 'string' ? video.duration : null,
            source: 'json-ld'
        };
    }
    return null;
}

function fromMetaTags() {
    const title = firstNonEmpty(
        metaContent('meta[property="og:title"]'),
        metaContent('meta[name="og:title"]'),
        metaContent('meta[name="twitter:title"]'),
        metaContent('meta[itemprop="name"]')
    );
    const thumbnail = firstNonEmpty(
        metaContent('meta[property="og:image"]'),
        metaContent('meta[name="twitter:image"]'),
        metaContent('meta[itemprop="thumbnailUrl"]')
    );
    if (!title && !thumbnail) return null;
    return {title: title, thumbnail: thumbnail, duration: null, source: 'meta-tags'};
}

// A poster attribute is a good thumbnail even when the title comes from elsewhere,
// and readyState/paused tell us whether anything is actually playing in this frame.
function fromVideoElements() {
    const videos = [...document.querySelectorAll('video')];
    if (videos.length === 0) return null;
    const playing = videos.find(v => !v.paused && !v.ended && v.readyState >= 2);
    const chosen = playing || videos[0];
    return {
        title: null,
        thumbnail: firstNonEmpty(chosen.getAttribute('poster')),
        duration: null,
        source: 'video-element',
        video_count: videos.length,
        is_playing: !!playing,
        width: chosen.videoWidth || null,
        height: chosen.videoHeight || null,
        // For an MSE player this is a blob: URL and useless for matching against a
        // network capture - recorded only so the popup can say so rather than
        // silently failing to correlate.
        current_src: chosen.currentSrc || null
    };
}

function collect() {
    const json_ld = fromJsonLd();
    const meta = fromMetaTags();
    const element = fromVideoElements();

    // Title preference: JSON-LD is nearly always the real video name; og:title is
    // usually right but sometimes carries site branding; document.title is the
    // last resort and often has " | Site Name" appended.
    const title = firstNonEmpty(
        json_ld && json_ld.title,
        meta && meta.title,
        document.title
    );

    return {
        title: title,
        title_source: (json_ld && json_ld.title) ? 'json-ld'
            : ((meta && meta.title) ? 'og:title' : 'document.title'),
        document_title: document.title || null,
        thumbnail: firstNonEmpty(
            json_ld && json_ld.thumbnail,
            element && element.thumbnail,
            meta && meta.thumbnail
        ),
        duration: json_ld && json_ld.duration,
        video_count: element ? element.video_count : 0,
        is_playing: element ? element.is_playing : false,
        width: element ? element.width : null,
        height: element ? element.height : null,
        current_src: element ? element.current_src : null,
        page_url: location.href
    };
}

function report() {
    try {
        browser.runtime.sendMessage({action: 'pageMetadata', metadata: collect()});
    } catch (e) {
        // Background not listening (e.g. during reload) - nothing to do.
    }
}

report();

// SPA route changes and lazily-initialised players both mean the metadata at
// document_idle is often not the final state. Re-report on the events that
// actually matter rather than polling.
window.addEventListener('load', report, {once: true});
document.addEventListener('play', report, true);
setTimeout(report, 2500);

browser.runtime.onMessage.addListener(message => {
    if (message.action === 'requestMetadata') return Promise.resolve(collect());
    return undefined;
});
