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
})();

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
