const capturesEl = document.getElementById('captures');
const statusEl = document.getElementById('status');
const segmentsEl = document.getElementById('segments');

let activeTabId = null;

function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = `status ${kind}`;
}

function formatSize(bytes) {
    if (!bytes) return null;
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

function tag(text, kind = '') {
    const el = document.createElement('span');
    el.className = `tag ${kind}`.trim();
    el.textContent = text;
    return el;
}

// Highest resolution a master playlist offers, which is what yt-dlp will pick by
// default and therefore what the user is actually choosing.
function bestVariant(variants) {
    if (!variants || variants.length === 0) return null;
    const withRes = variants.filter(v => v.resolution);
    if (withRes.length === 0) return null;
    return withRes.reduce((best, v) => {
        const height = Number((v.resolution.split('x')[1] || 0));
        const bestHeight = Number((best.resolution.split('x')[1] || 0));
        return height > bestHeight ? v : best;
    });
}

function render(result) {
    const captures = result.captures || [];
    const segmentCount = result.segmentCount || 0;
    const metadata = result.metadata || null;

    capturesEl.replaceChildren();

    if (captures.length === 0 && segmentCount > 0) {
        // The common false dead-end: hls.js fetches its manifest once, at player
        // init. Clearing after that and pressing play yields only segments, which
        // are suppressed - so it looks like nothing was found.
        setStatus(`Only stream segments seen (${segmentCount}), no manifest. ` +
                  `The player fetched its manifest before you cleared. Reload the page, ` +
                  `then press play - do not clear in between.`, 'error');
    } else if (captures.length === 0) {
        setStatus('Nothing captured yet. Start playing the video on the page, then reopen this popup.');
    } else if (metadata && metadata.title) {
        setStatus(`Will be saved as: ${metadata.title}`, 'ok');
    } else {
        setStatus(`${captures.length} candidate${captures.length === 1 ? '' : 's'}.`);
    }

    segmentsEl.textContent = segmentCount ? `${segmentCount} segments ignored` : '';

    for (const capture of captures) {
        const item = document.createElement('li');

        const url = document.createElement('div');
        url.className = 'url';
        url.textContent = capture.url;
        item.append(url);

        const meta = document.createElement('div');
        meta.className = 'meta';

        // Ordered by how much each fact helps the choice.
        if (capture.is_playing) meta.append(tag('▶ playing now', 'playing'));
        // Worth calling out loudly: a subtitle rendition looks like any other
        // stream, and sending one gets you a .vtt named like a video.
        if (capture.is_subtitles) meta.append(tag('subtitles, not video', 'session'));
        if (capture.playlist_kind === 'master') {
            const best = bestVariant(capture.variants);
            meta.append(tag(
                best ? `master playlist · ${capture.variants.length} variants · up to ${best.resolution}`
                     : `master playlist · ${capture.variants.length} variants`,
                'manifest'));
        } else if (capture.playlist_kind === 'media') {
            meta.append(tag(
                capture.segment_count ? `single rendition · ${capture.segment_count} segments`
                                      : 'single rendition',
                ''));
        } else if (capture.is_manifest) {
            meta.append(tag('manifest', 'manifest'));
        }
        if (capture.content_type) meta.append(tag(capture.content_type));
        const size = formatSize(capture.content_length);
        if (size) meta.append(tag(size));
        if (capture.cookie) meta.append(tag('has cookies', 'session'));
        if (capture.status && capture.status >= 400) meta.append(tag(`HTTP ${capture.status}`, 'session'));
        item.append(meta);

        const send = document.createElement('button');
        send.className = 'send';
        send.textContent = 'Send to Material';
        send.addEventListener('click', async () => {
            send.disabled = true;
            send.textContent = 'Sending…';
            const res = await browser.runtime.sendMessage({
                action: 'sendToMaterial', capture: capture, tabId: activeTabId
            });
            if (res && res.success) {
                send.textContent = 'Sent ✓';
                setStatus('Queued in Material. It downloads immediately, since these URLs often expire.'
                    // Say so when yt-dlp's extension guard was waived. It is waived
                    // on the browser's evidence rather than a prompt, but it should
                    // never happen silently.
                    + (res.preauthorised_extension
                        ? ' The unusual file extension was allowed automatically, because the server returned a media content type.'
                        : ''), 'ok');
            } else {
                send.disabled = false;
                send.textContent = 'Send to Material';
                setStatus((res && res.error) || 'Send failed.', 'error');
            }
        });
        item.append(send);

        capturesEl.append(item);
    }
}

// Diagnostic view: every request seen, and why each was or was not captured. This
// is what to look at when a player is not detected at all.
function renderDiagnostics(rows) {
    capturesEl.replaceChildren();
    setStatus(`${rows.length} request(s) seen on this tab. "not media" rows are what the filters rejected.`);

    for (const row of rows) {
        const item = document.createElement('li');

        const url = document.createElement('div');
        url.className = 'url';
        url.textContent = row.url;
        item.append(url);

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.append(tag(row.verdict, row.verdict === 'CAPTURED' ? 'manifest' : ''));
        meta.append(tag(`type=${row.resource_type}`));
        meta.append(tag(row.content_type || 'no content-type'));
        meta.append(tag(row.content_length ? formatSize(row.content_length) : 'no length'));
        meta.append(tag(`HTTP ${row.status}`));
        item.append(meta);

        capturesEl.append(item);
    }
}

document.getElementById('options').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
});

(async () => {
    const [tab] = await browser.tabs.query({active: true, currentWindow: true});
    if (!tab) {
        setStatus('No active tab.', 'error');
        return;
    }
    activeTabId = tab.id;

    document.getElementById('clear').addEventListener('click', async () => {
        await browser.runtime.sendMessage({action: 'clearCaptures', tabId: tab.id});
        render({captures: [], segmentCount: 0});
    });

    document.getElementById('diagnostics').addEventListener('click', async () => {
        const res = await browser.runtime.sendMessage({action: 'getDiagnostics', tabId: tab.id});
        renderDiagnostics(res.diagnostics || []);
    });

    document.getElementById('copy').addEventListener('click', async () => {
        const res = await browser.runtime.sendMessage({action: 'getDiagnostics', tabId: tab.id});
        await navigator.clipboard.writeText(JSON.stringify(res.diagnostics || [], null, 2));
        setStatus('Diagnostics copied to the clipboard.', 'ok');
    });

    render(await browser.runtime.sendMessage({action: 'getCaptures', tabId: tab.id}));
})();
