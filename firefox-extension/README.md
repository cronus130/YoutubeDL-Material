# YTDL-Material Capture (Firefox extension)

Piece 2 of the site-detection project. Watches network traffic for media requests,
remembers the headers that made them work, and sends a chosen one to
YoutubeDL-Material.

It exists because the server-side fallback (Piece 1) has a hard ceiling: on most
real sites the media URL does not exist until the player initialises, so there is
nothing in the HTML or the JS bundles to find. Only a real browser session
produces it.

A side benefit: `webRequest` listeners run in the extension's own process, so page
JavaScript cannot see or interfere with them. The anti-devtools tricks some sites
use — `debugger` traps, `console.clear()` loops, key interception — have nothing
to act on here.

## Status

Built, linted clean by Mozilla's `addons-linter` (0 errors, 0 warnings, 0
notices). **Not yet signed or installed** — that needs an AMO account, which is
yours to create.

## What it does

- Two listeners, correlated by `requestId`: `onBeforeSendHeaders` for the request
  side (Cookie, Referer, User-Agent) and `onHeadersReceived` for the response side
  (Content-Type, Content-Length). Content type is only available on the response,
  so both are required.
- HLS/DASH **segments are suppressed** and shown as a count. A single playback
  fires hundreds of `.ts` requests and none is individually useful — yt-dlp wants
  the manifest, which is captured and tagged.
- Captures **persist across navigation**. A site that defensively reloads itself
  would otherwise wipe everything captured so far.
- Sends to `POST /api/capture` authenticated with `?apiKey=`, the same middleware
  every other endpoint uses. No separate shared secret.

Deliberately **no content script** in v1. DOM highlighting is the only part a
hostile page could fight (content scripts share the DOM even though the page
cannot read their variables), and the popup list is where the value is.

## Build

```bash
./package.sh
```

Writes `../ytdlm-capture-<version>.zip` with `manifest.json` at the archive root,
which is what AMO requires. Re-lint any time with:

```bash
npx web-ext lint --source-dir .
```

## Submitting for unlisted signing

Unlisted (self-distribution) signing is free and never appears publicly on AMO.
It produces a signed `.xpi` that installs permanently in **release Firefox** —
unlike `about:debugging`, which is wiped on every browser restart, and unlike
`xpinstall.signatures.required=false`, which only works on Developer Edition,
Nightly and ESR.

1. Create a Mozilla account and sign in at <https://addons.mozilla.org/developers/>
2. Go to <https://addons.mozilla.org/developers/addon/submit/distribution>
3. Choose **"On your own"** — this is the unlisted/self-distribution option. Do
   not choose "On this site", which lists it publicly and invites human review.
4. Upload `ytdlm-capture-1.0.0.zip`
5. Validation runs the same `addons-linter` already run here, so it should pass
   without comment
6. Download the signed `.xpi` when it appears (usually a few minutes)
7. Install it: Firefox → `about:addons` → gear icon → **Install Add-on From
   File** → pick the `.xpi`

The add-on ID is pinned in the manifest as
`ytdlm-capture@cronus130.github.io`. Keep it stable — AMO ties the listing to it,
and changing it creates a separate add-on. Bump `version` in `manifest.json` for
every re-upload; AMO rejects a duplicate version.

## Testing before AMO signing comes back

AMO review can take a few days. Two ways to run it in the meantime, both on
**Firefox Developer Edition** — release Firefox will not load unsigned add-ons at
all, regardless of preferences.

### Permanent unsigned install

1. In Developer Edition open `about:config`, accept the warning, search for
   `xpinstall.signatures.required` and set it to **false**.
2. `about:addons` → gear icon → **Install Add-on From File**
3. Pick `../ytdlm-capture-1.0.0-unsigned.xpi`

It survives restarts. To update: bump `version` in the manifest, re-run
`./package.sh`, and install over the top.

This works because the manifest pins an explicit add-on ID — unsigned installs are
rejected without one.

### Faster loop while iterating

```bash
./dev-run.sh
```

Launches Developer Edition with the extension loaded and **reloads it on every
file change**, so there is no rebuild/reinstall cycle. It uses a dedicated
persistent profile (`ytdlm-capture`), created on first run, so logins on the sites
being tested survive between runs. The extension itself is loaded temporarily and
is gone when that Firefox closes.

### The gotcha worth knowing

**Developer Edition has its own profile**, entirely separate from release Firefox.
Your existing logins are not there. Since the whole point of this extension is
capturing session cookies, you have to **log into the target sites inside
Developer Edition** (or the `ytdlm-capture` profile) before capture will produce
anything usable. A capture taken while logged out will look fine in the popup and
then 403 server-side.

When the signed `.xpi` arrives from AMO, install that in release Firefox and the
`xpinstall.signatures.required` change is no longer needed — set it back to `true`.

## Configuring it

1. In Material: **Settings → Advanced**, enable **Use API key** and copy the key.
2. In Firefox: `about:addons` → the extension → **Preferences**. Set the Material
   base URL (e.g. `http://192.168.1.10:9998` — the port your container publishes,
   not Material's internal 17442) and paste the API key.
3. Press **Save & test**. It verifies the URL and key rather than only storing them,
   and prompts for host access if it is missing.

### Host access is not automatic

Firefox MV3 treats manifest `host_permissions` as *requested*, not granted, so a
fresh install has no access to whatever host you configure — and granting access on
a video site does not extend to your Material host. **Save & test** asks for it, but
if the prompt does not appear, enable it manually at `about:addons` → the extension
→ **Permissions** → **"Access your data for all websites"**.

Worth knowing what this looks like when it is missing, because it impersonates
every other problem. Without the grant the extension's `fetch` is not privileged,
so it counts as an ordinary request from `moz-extension://` — a secure context —
which makes an `http://` call mixed content, and Firefox upgrades that to HTTPS.
Against a plain-HTTP server the handshake fails with
`SSL_ERROR_RX_RECORD_TOO_LONG`, surfacing as a bare `NetworkError`. It reads as a
wrong URL, a wrong key, or an HTTPS-First pref, and is none of them.

## Using it

1. Open the page and **start playing the video** — nothing is captured until the
   player actually requests media.
2. Click the toolbar icon. The badge shows how many candidates were found.
3. Prefer a **stream manifest** if one is tagged; otherwise the largest
   progressive file.
4. **Send to Material.** It downloads immediately rather than waiting for
   confirmation, because captured URLs are often signed with a short expiry. The
   download is visible and cancellable in Material's Downloads view.

## Known limitations

- Captured cookies are a point-in-time snapshot. When the session expires the URL
  stops working and the page needs recapturing.
- The backend writes cookies to a Netscape jar under
  `appdata/capture-cookies/`, scoped to both the media host and the page host, and
  prunes jars older than 6 hours. Those files are live session credentials for as
  long as they exist.
- A capture whose URL is bound to the browser's IP will fail server-side if the
  NAS egresses differently — relevant if the VPN toggle is on.
