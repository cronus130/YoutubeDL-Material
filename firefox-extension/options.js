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

document.getElementById('save').addEventListener('click', async () => {
    const materialUrl = urlInput.value.trim().replace(/\/+$/, '');
    const apiKey = keyInput.value.trim();

    if (!materialUrl) {
        setStatus('Enter the Material URL.', 'error');
        return;
    }
    // http is expected here - this is a LAN address, not a public site.
    if (!/^https?:\/\//i.test(materialUrl)) {
        setStatus('URL must start with http:// or https://', 'error');
        return;
    }
    if (!apiKey) {
        setStatus('Enter the API key.', 'error');
        return;
    }

    await browser.storage.local.set({materialUrl: materialUrl, apiKey: apiKey});
    setStatus('Saved.', 'ok');
});
