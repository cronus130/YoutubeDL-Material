// Receives media URLs captured by the Firefox extension, along with the request
// headers that made them work, and hands them to the normal download pipeline.
//
// The cookies are written to a Netscape cookie jar and passed with --cookies
// rather than --add-header "Cookie: ...". That is not a style preference:
// yt-dlp pops a Cookie header out of --add-header and reloads it into its
// cookiejar scoped to the *input URL's* hostname (YoutubeDL.py,
// _apply_header_cookies; ref GHSA-v8mc-9377-rwjj). Any redirect to a CDN on
// another host would then silently lose the cookies. A jar carries per-domain
// scoping, which is what these sites actually need.

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { v4: uuid } = require('uuid');

const logger = require('./logger');
const config_api = require('./config.js');

const COOKIE_DIR = path.join('appdata', 'capture-cookies');
// Captured cookies are live session credentials. They are kept only as long as a
// download plausibly needs them, then pruned.
const COOKIE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function hostOf(target) {
    try {
        return new URL(target).hostname;
    } catch (e) {
        return null;
    }
}

// Netscape format, one line per cookie:
//   domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
//
// The extension sends a raw Cookie header, which carries no domain or path - only
// names and values. They were observed on a request to `host`, so that is the
// correct scope. includeSubdomains is TRUE so a sibling CDN host under the same
// registrable domain still matches.
exports.writeCookieJar = async (cookieHeader, host, extraHosts = []) => {
    if (!cookieHeader || !host) return null;

    const pairs = cookieHeader
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
            const index = part.indexOf('=');
            if (index <= 0) return null;
            return {name: part.slice(0, index).trim(), value: part.slice(index + 1).trim()};
        })
        .filter(Boolean);

    if (pairs.length === 0) return null;

    await fs.ensureDir(COOKIE_DIR);
    const jar_path = path.join(COOKIE_DIR, `capture-${uuid()}.txt`);

    // yt-dlp requires this exact header line to accept the file.
    const lines = ['# Netscape HTTP Cookie File', '# Written by YoutubeDL-Material capture', ''];
    const expiry = Math.floor((Date.now() + COOKIE_MAX_AGE_MS) / 1000);
    const hosts = [...new Set([host, ...extraHosts.filter(Boolean)])];

    for (const cookie_host of hosts) {
        for (const pair of pairs) {
            lines.push([`.${cookie_host}`, 'TRUE', '/', 'FALSE', expiry, pair.name, pair.value].join('\t'));
        }
    }

    await fs.writeFile(jar_path, `${lines.join('\n')}\n`, {mode: 0o600});
    logger.verbose(`capture: wrote cookie jar for ${hosts.join(', ')} (${pairs.length} cookie(s))`);
    return jar_path;
};

// Deletes jars older than COOKIE_MAX_AGE_MS. Called on each capture so there is
// no scheduled task to forget about; the directory stays small either way.
exports.pruneCookieJars = async () => {
    if (!await fs.pathExists(COOKIE_DIR)) return;
    const now = Date.now();
    let removed = 0;
    for (const name of await fs.readdir(COOKIE_DIR)) {
        const jar_path = path.join(COOKIE_DIR, name);
        try {
            const stats = await fs.stat(jar_path);
            if (now - stats.mtimeMs > COOKIE_MAX_AGE_MS) {
                await fs.remove(jar_path);
                removed++;
            }
        } catch (e) {
            // Nothing actionable if a jar vanishes mid-prune.
        }
    }
    if (removed) logger.verbose(`capture: pruned ${removed} expired cookie jar(s)`);
};

// additionalArgs is split on ',,' by generateArgs, so every token is separate.
// Values are not escaped anywhere downstream, so a ',,' inside one would break
// the split - checked rather than hoped for.
function buildArgs(tokens) {
    for (const token of tokens) {
        if (typeof token === 'string' && token.includes(',,')) {
            throw new Error('Captured header value contains ",," which cannot be passed safely.');
        }
    }
    return tokens.join(',,');
}

// Content types that mean the browser already saw real media come back.
const MEDIA_CONTENT_TYPE = /^(?:video\/|audio\/|application\/(?:x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|f4m|smil))/i;

// Turns a capture into the additionalArgs string the pipeline understands.
// Returns {additionalArgs, jar_path, preauthorised_extension}.
exports.buildCaptureArgs = async ({url, referer, cookie, user_agent, source_page_url, content_type}) => {
    const media_host = hostOf(url);
    const page_host = hostOf(source_page_url || referer || '');
    const jar_path = await exports.writeCookieJar(cookie, media_host, [page_host]);

    const tokens = [];
    // Referer is what most of these endpoints actually check.
    if (referer) tokens.push('--referer', referer);
    if (user_agent) tokens.push('--user-agent', user_agent);
    if (jar_path) tokens.push('--cookies', jar_path);

    // These endpoints routinely have no media extension in the path
    // (remote_control.php?file=...), which yt-dlp refuses to write without this
    // flag. Normally that refusal raises a confirmation prompt - but here the
    // browser already observed the server returning a media content type, on a
    // request the user explicitly chose to send. That is better evidence than the
    // prompt could offer, so authorise it up front rather than asking every time.
    //
    // If the content type is absent or not media, the flag is withheld and the
    // prompt still happens. The guard is not disabled, just satisfied differently.
    const preauthorised = !!content_type && MEDIA_CONTENT_TYPE.test(content_type);
    if (preauthorised) {
        tokens.push('--compat-options', 'allow-unsafe-ext');
        // Logged at info so it shows in Settings > Logs. Silently overriding a
        // safety guard is how a filename mismatch went unnoticed until it crashed
        // the app, so this decision is always recorded even when it is not queried.
        const path_ext = (() => {
            try {
                const last = (new URL(url).pathname.split('/').pop() || '');
                return last.includes('.') ? last.split('.').pop().toLowerCase() : null;
            } catch (e) {
                return null;
            }
        })();
        logger.info(`capture: allowing unusual file extension`
            + `${path_ext ? ` '.${path_ext}'` : ''} for ${media_host} `
            + `because the browser saw the server return ${content_type}`);
    }

    return {
        additionalArgs: tokens.length ? buildArgs(tokens) : '',
        jar_path: jar_path,
        preauthorised_extension: preauthorised
    };
};

// Builds a safe output filename for a capture.
//
// Necessary because these CDN URLs carry a signed token where the filename should
// be - commonly 400-700 characters. yt-dlp's generic extractor derives %(title)s
// from the URL, and the app's default template is "<folder>/%(title)s.mp4", so the
// resulting path component lands far over the 255-byte per-component limit every
// filesystem here enforces, and the download dies with ENAMETOOLONG.
//
// Returns a name with no extension (the caller appends .%(ext)s) and no path
// separators, since it is joined onto the download folder.
exports.buildOutputName = ({page_title, url, source_page_url}) => {
    let base = (page_title || '').trim();

    if (!base) {
        // No title from the browser: fall back to the page host, then the media
        // host, so the file is at least identifiable.
        base = hostOf(source_page_url) || hostOf(url) || 'capture';
    }

    base = base
        // '%' would be read as an output-template placeholder by yt-dlp.
        .replace(/%/g, '')
        // Path separators and characters that are illegal or awkward on
        // Windows/macOS/Linux shares.
        .replace(/[/\\:*?"<>|]/g, '-')
        // Control characters.
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        // Leading dots would make it hidden, trailing dots/spaces are trouble on
        // SMB shares.
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '');

    if (!base) base = 'capture';

    // Well inside 255 bytes even after '.%(ext)s' and multi-byte characters.
    // Sliced by code point, then trimmed by byte length for non-ASCII titles.
    base = base.slice(0, 120);
    while (Buffer.byteLength(base, 'utf8') > 180) base = base.slice(0, -1);

    return base;
};

// Saves the page's poster image next to where the video will land, named to match,
// so the app's own thumbnail lookup (utils.getDownloadedThumbnail, which looks for
// a sibling file with the same basename) finds it when the file is registered.
//
// Needed because yt-dlp's --write-thumbnail has nothing to work with here: a bare
// CDN or manifest URL carries no metadata, so captures would never have a preview.
// Entirely best-effort - any failure is logged and ignored, never affecting the
// download.
exports.fetchPosterImage = async (thumbnail_url, folder, output_name) => {
    if (!thumbnail_url || !/^https?:\/\//i.test(thumbnail_url)) return null;

    try {
        const response = await axios.get(thumbnail_url, {
            timeout: 15000,
            responseType: 'arraybuffer',
            maxContentLength: 8 * 1024 * 1024,
            maxRedirects: 5
        });

        const content_type = (response.headers['content-type'] || '').toLowerCase();
        // Only accept something that really is an image; a login page redirect
        // would otherwise be written out as a poster.
        const ext = content_type.includes('png') ? 'png'
            : content_type.includes('webp') ? 'webp'
            : (content_type.includes('jpeg') || content_type.includes('jpg')) ? 'jpg'
            : null;
        if (!ext) {
            logger.verbose(`capture: poster at ${thumbnail_url} was ${content_type || 'untyped'}, not an image - skipping`);
            return null;
        }

        await fs.ensureDir(folder);
        const poster_path = path.join(folder, `${output_name}.${ext}`);
        await fs.writeFile(poster_path, Buffer.from(response.data));
        logger.verbose(`capture: saved poster image to ${poster_path}`);
        return poster_path;
    } catch (e) {
        logger.verbose(`capture: could not fetch poster ${thumbnail_url}: ${e.message}`);
        return null;
    }
};

exports.COOKIE_DIR = COOKIE_DIR;
