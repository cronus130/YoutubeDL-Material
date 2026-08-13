#!/usr/bin/env node
// URL validation harness for the site-detection fallback.
//
// Runs the same detection code the download pipeline uses, prints what it found
// and why, and optionally asks yt-dlp what it makes of each candidate - without
// touching the download queue or writing any files.
//
//   node site-detection-cli.js <url>                 detect + probe
//   node site-detection-cli.js <url> --ytdlp          also run yt-dlp on each candidate
//   node site-detection-cli.js <url> --baseline       first show what yt-dlp does with the page itself
//   node site-detection-cli.js <url> --json           machine-readable output
//   node site-detection-cli.js <url> --no-probe       skip HEAD/range probing
//
// Run it from the backend/ directory (or any directory containing appdata/), so
// config and the yt-dlp binary resolve the same way the app resolves them.

const path = require('path');
const fs = require('fs');
const execa = require('execa');

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('-'));
const flag = name => args.includes(`--${name}`);

if (!target) {
    console.error('Usage: node site-detection-cli.js <url> [--ytdlp] [--baseline] [--json] [--no-probe]');
    process.exit(2);
}

// The app reads config relative to cwd; make that explicit so this works when
// invoked from elsewhere.
if (!fs.existsSync(path.join(process.cwd(), 'appdata'))) {
    console.error(`No appdata/ in ${process.cwd()} - run this from the app root (where appdata/ lives).`);
    process.exit(2);
}

const detection = require('./site-detection');
const CONSTS = require('./consts');

const BINARY = path.join('appdata', 'bin', 'yt-dlp');

function truncate(value, length = 108) {
    const text = String(value == null ? '' : value);
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

// Runs yt-dlp read-only. Returns what happened, including the refused extension
// if yt-dlp declined to write the file - the same parse the pipeline uses.
async function askYtdlp(url, extraArgs = []) {
    if (!fs.existsSync(BINARY)) return {ran: false, reason: `no binary at ${BINARY}`};
    const ytdlpArgs = [url, '--simulate', '--no-warnings', '--no-playlist',
                       '--print', '%(extractor)s\t%(ext)s\t%(format_id)s\t%(title)s', ...extraArgs];
    try {
        const {stdout} = await execa(BINARY, ytdlpArgs, {timeout: 90000, reject: true});
        const [extractor, ext, format, title] = (stdout.trim().split('\n')[0] || '').split('\t');
        return {ran: true, ok: true, extractor, ext, format, title};
    } catch (e) {
        const stderr = `${e.stderr || ''}${e.stdout || ''}`;
        const unsafe = stderr.match(CONSTS.UNSAFE_EXTENSION_REGEX);
        return {
            ran: true, ok: false,
            unsupported: /Unsupported URL/i.test(stderr),
            unsafe_extension: unsafe ? unsafe[1] : null,
            error: truncate(stderr.split('\n').filter(l => /^ERROR|^WARNING/.test(l))[0] || stderr.split('\n')[0], 200)
        };
    }
}

function describeYtdlp(verdict, indent = '      ') {
    if (!verdict.ran) return `${indent}yt-dlp: not run (${verdict.reason})`;
    if (verdict.ok) return `${indent}yt-dlp: OK  extractor=${verdict.extractor} ext=${verdict.ext} format=${verdict.format}`;
    let line = `${indent}yt-dlp: FAILED${verdict.unsupported ? ' (Unsupported URL)' : ''}`;
    if (verdict.unsafe_extension) {
        line += `\n${indent}        refused to write extension '${verdict.unsafe_extension}'` +
                ` -> needs confirmation, then --compat-options allow-unsafe-ext`;
    }
    return `${line}\n${indent}        ${verdict.error}`;
}

(async () => {
    const out = {url: target};

    if (flag('baseline')) {
        const baseline = await askYtdlp(target);
        out.baseline = baseline;
        if (!flag('json')) {
            console.log(`\n=== baseline: what yt-dlp does with the page itself ===`);
            console.log(describeYtdlp(baseline, '  '));
            if (baseline.ran && baseline.ok) {
                console.log('  -> yt-dlp already handles this URL; the fallback would never fire.');
            }
        }
    }

    const started = Date.now();
    const result = await detection.detectCandidates(target, {probe: !flag('no-probe')});
    out.detection = result;
    out.elapsed_ms = Date.now() - started;

    if (flag('json') && !flag('ytdlp')) {
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    if (!flag('json')) {
        console.log(`\n=== detection (${out.elapsed_ms}ms) ===`);
        console.log(`  page          : ${target}`);
        if (result.final_url && result.final_url !== target) console.log(`  after redirect: ${result.final_url}`);
        console.log(`  candidates    : ${result.candidates.length}`);
        console.log(`  needs session : ${result.needs_session}${result.needs_session ? '  <- Piece 2 case' : ''}`);
        for (const note of result.notes) console.log(`  note          : ${note}`);
    }

    for (const [index, candidate] of result.candidates.entries()) {
        if (!flag('json')) {
            console.log(`\n  [${index + 1}] confidence ${candidate.confidence}  (${candidate.found_in} / ${candidate.how})`);
            console.log(`      ${truncate(candidate.url)}`);
            const bits = [];
            if (candidate.path_extension) bits.push(`path ext '${candidate.path_extension}'`);
            else bits.push('no path extension');
            if (candidate.content_type) bits.push(`served as ${candidate.content_type}`);
            if (candidate.probe && candidate.probe.content_length) {
                bits.push(`${(candidate.probe.content_length / 1048576).toFixed(1)} MB`);
            }
            if (candidate.probe && !candidate.probe.ok) bits.push(`probe failed: ${candidate.probe.error}`);
            if (candidate.needs_session) bits.push('needs session');
            console.log(`      ${bits.join('  |  ')}`);

            // The mismatch that drives the extension warning prompt.
            if (candidate.server_says_media && candidate.looks_like_media_path === false) {
                console.log(`      NOTE: server says media but the path has no media extension` +
                            ` - yt-dlp will refuse to write '${candidate.path_extension || 'unknown'}' without confirmation.`);
            }
        }
        if (flag('ytdlp') && !candidate.is_embed) {
            candidate.ytdlp = await askYtdlp(candidate.url);
            if (!flag('json')) console.log(describeYtdlp(candidate.ytdlp));
            if (candidate.ytdlp.unsafe_extension) {
                candidate.ytdlp_with_override = await askYtdlp(candidate.url, ['--compat-options', 'allow-unsafe-ext']);
                if (!flag('json')) {
                    console.log(`      retry with allow-unsafe-ext:`);
                    console.log(describeYtdlp(candidate.ytdlp_with_override, '        '));
                }
            }
        }
    }

    if (flag('json')) {
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    console.log('');
    const usable = result.candidates.filter(c => c.is_embed || (c.probe && c.probe.ok));
    if (!result.ok) {
        console.log('  VERDICT: nothing found. This is a Piece 2 (browser extension) case.');
    } else if (usable.length === 0) {
        console.log('  VERDICT: candidates found but none fetchable - Piece 2 case (needs a real session).');
    } else if (usable.length === 1) {
        console.log('  VERDICT: one usable candidate - the pipeline would retry it automatically.');
    } else {
        console.log(`  VERDICT: ${usable.length} usable candidates - the pipeline would ask which one to use.`);
    }
    console.log('');
})().catch(err => {
    console.error(`\nharness error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
