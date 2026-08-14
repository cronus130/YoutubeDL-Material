const urlInput = document.getElementById('materialUrl');
const keyInput = document.getElementById('apiKey');
const statusEl = document.getElementById('status');

function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = `status ${kind}`;
}

(async () => {
    const stored = await browser.storage.local.get(['materialUrl', 'apiKey']);
    if (stored.materialUrl) urlInput.value = stored.materialUrl;
    if (stored.apiKey) keyInput.value = stored.apiKey;

    // Surface a missing grant on open rather than waiting for a send to fail.
    if (stored.materialUrl && !await hasHostAccess(stored.materialUrl)) {
        setStatus(`No permission to reach ${new URL(stored.materialUrl).hostname} yet - press "Save & test" to grant it.`, 'error');
    }
})();

// Host access
// ---------------------------------------------------------------------------
// Firefox MV3 treats manifest host_permissions as requested, not granted, so a
// fresh install has no access to whatever host gets configured here. Without the
// grant the extension's fetch is not privileged: it is treated as an ordinary
// request from moz-extension://, which is a secure context, making a http:// call
// mixed content - and Firefox upgrades that to HTTPS. Against a plain-HTTP server
// the handshake then fails with SSL_ERROR_RX_RECORD_TOO_LONG, which looks nothing
// like a permission problem and sends you hunting through HTTPS-First prefs.
//
// Match patterns cannot carry a port, so the pattern covers the host on any port.
function originPattern(base) {
    const url = new URL(base);
    return `${url.protocol}//${url.hostname}/*`;
}

async function hasHostAccess(base) {
    try {
        return await browser.permissions.contains({origins: [originPattern(base)]});
    } catch (e) {
        return false;
    }
}

// Must be called from a click handler - Firefox requires a user gesture.
async function requestHostAccess(base) {
    try {
        return await browser.permissions.request({origins: [originPattern(base)]});
    } catch (e) {
        return false;
    }
}

// Returns the cleaned values, or null after reporting why they are unusable.
function readInputs() {
    const materialUrl = urlInput.value.trim().replace(/\/+$/, '');
    const apiKey = keyInput.value.trim();

    if (!materialUrl) {
        setStatus('Enter the Material URL.', 'error');
        return null;
    }
    // http is expected here - this is a LAN address, not a public site.
    if (!/^https?:\/\//i.test(materialUrl)) {
        setStatus('URL must start with http:// or https://', 'error');
        return null;
    }
    if (!apiKey) {
        setStatus('Enter the API key.', 'error');
        return null;
    }
    return {materialUrl, apiKey};
}

// The background page runs the probe: webRequest lives there, and it is what
// turns fetch's single opaque NetworkError into an attributable cause.
async function runTest(materialUrl, apiKey, prefix = '') {
    // Checked before anything is sent, because a missing grant fails in a way that
    // impersonates every other problem - and it cannot be requested later from
    // background code, which has no user gesture to attach the prompt to.
    if (!await hasHostAccess(materialUrl)) {
        setStatus(`${prefix}Requesting access to ${new URL(materialUrl).hostname}...`);
        if (!await requestHostAccess(materialUrl)) {
            setStatus(
                `${prefix}This extension has no permission to reach ${new URL(materialUrl).hostname}, and the request ` +
                `was dismissed or unavailable here. Grant it in about:addons -> YTDL-Material Capture -> Permissions ` +
                `-> "Access your data for all websites", then test again. Without it Firefox rewrites the request to ` +
                `HTTPS and the connection fails in a way that looks like a wrong URL or key.`,
                'error');
            return false;
        }
    }

    setStatus(`${prefix}Testing connection...`);
    const result = await browser.runtime.sendMessage({
        action: 'testConnection',
        base: materialUrl,
        apiKey: apiKey
    });
    if (result && result.success) setStatus(`${prefix}${result.message}`, 'ok');
    else setStatus(`${prefix}${(result && result.error) || 'Test failed.'}`, 'error');
    return !!(result && result.success);
}

// Saving verifies rather than just storing - settings that look right but do not
// work are the whole problem this avoids. The values are still saved either way,
// so a failed test leaves something to correct instead of discarding the input.
document.getElementById('save').addEventListener('click', async () => {
    const values = readInputs();
    if (!values) return;

    await browser.storage.local.set({materialUrl: values.materialUrl, apiKey: values.apiKey});
    await runTest(values.materialUrl, values.apiKey, 'Saved. ');
});

// Tests what is typed, without saving it.
document.getElementById('test').addEventListener('click', async () => {
    const values = readInputs();
    if (!values) return;
    await runTest(values.materialUrl, values.apiKey);
});
