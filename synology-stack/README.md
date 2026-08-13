# YoutubeDL-Material stack for Synology (DSM 7.3.x, Container Manager)

Deployable stack for YoutubeDL-Material plus a sidecar that keeps `yt-dlp`
current, verified, and rollback-able — without restarting the app.

Built from `HANDOFF.md` in the repo root. The optional VPN egress path is
included but **not enabled**; see [docs/VPN-ROUTING.md](docs/VPN-ROUTING.md).

## What's here

```
docker-compose.yml        the running stack: app + mongo + updater sidecar
docker-compose.vpn.yml    optional gluetun VPN overlay - not used by default
.env.example              copy to .env and edit
updater/                  the sidecar: Dockerfile, loop, update + rollback scripts
scripts/                  local test helpers (no Docker required)
docs/VPN-ROUTING.md       the whole VPN feature, start to finish
```

## The app changes in this fork

Two things were added to the application itself, which is why this stack runs a
fork build rather than upstream's image.

**yt-dlp status in the top bar.** Shows the installed version at a glance; the
panel behind it adds when it was last updated, when it was last checked, the
channel and flavor in use, and a **Check for updates** button.

That button deliberately does *not* call the app's own `Update youtube-dl` task —
that task runs the app's unverified downloader and would replace whatever the
sidecar installed. Instead the backend writes a trigger file into `appdata/`,
which the sidecar picks up within about ten seconds. The shared appdata volume
stays the only channel between the two: no ports, no network coupling. The widget
then polls until the sidecar reports back.

With no sidecar deployed the widget still shows the version the app recorded, says
so, and disables the button rather than pretending to work.

**VPN toggle in Settings.** *Settings → Downloader → Route downloads through VPN*,
plus a proxy URL field. When on, the backend adds `--proxy <url>` to every yt-dlp
invocation. A `--proxy` written by hand into Global custom args still wins.

Both are served by two new endpoints, `GET /api/ytdlpStatus` and
`POST /api/ytdlpCheckNow`, and two new config items under `Downloader`.

## Building and delivering the image

`.github/workflows/docker.yml` builds on every push to `master` and pushes to
`ghcr.io/<owner>/youtubedl-material`. It differs from upstream's workflow
deliberately: ghcr.io only (authenticating with the automatic `GITHUB_TOKEN`, so
there are no registry secrets to manage), `linux/amd64` only since the target NAS is
x86_64, and `$GITHUB_OUTPUT` in place of the deprecated `::set-output`.

Two one-time things after the first build:

- **Forks have Actions disabled by default** — enable them on the repo's Actions tab.
- **GHCR packages are created private.** Make the package public (Profile →
  Packages → youtubedl-material → Package settings → Change visibility), or run
  `docker login ghcr.io` on the NAS with a token that has `read:packages`.

### Never use upstream's `latest` tag

If you ever point `APP_IMAGE` back at `tzahi12345/youtubedl-material`, use a
`nightly` tag. Upstream's `latest` is the **v4.3.2 release image, built 2023-05-27
and never rebuilt** — internally a different application:

| | `latest` (v4.3.2, 2023) | `nightly` (master, 2025-03-18) |
|---|---|---|
| Binary location | `node_modules/youtube-dl/bin/youtube-dl` *inside the container* | `appdata/bin/<fork>` (persisted volume) |
| Version record | `node_modules/youtube-dl/bin/details`, flat JSON | `appdata/youtube-dl.json`, keyed by fork |
| Survives recreate | No | Yes |
| Manageable by this sidecar | **No** | Yes |

On `latest` the sidecar would run without errors and accomplish nothing — the app
would never look at the binary it manages. The updater logs a warning if it sees
the signature of the wrong layout.

## The thing to know before deploying

**The app ships its own yt-dlp updater, and it will fight a naive sidecar.**

On every boot (and whenever the `Update youtube-dl` task is scheduled),
`backend/youtube-dl.js` compares the version recorded in
`appdata/youtube-dl.json` against the newest tag on `yt-dlp/yt-dlp`. On any
mismatch it re-downloads the release binary over the top of `appdata/bin/yt-dlp`
— with **no checksum verification and no atomic replace**, so an interrupted
download leaves a truncated binary that fails every subsequent download.

A sidecar that only swaps the binary would therefore be silently reverted on the
next app restart. So this one also writes `appdata/youtube-dl.json`, recording
the version the app expects to see. The app then treats the binary as current and
leaves it alone. That is what `PIN_APP_UPDATER=true` does, and it is why it
defaults to on.

Two consequences worth knowing:

- On the **stable** channel the recorded version and the installed version are
  the same, so nothing is misreported anywhere.
- On **nightly**, the app's Settings page will show the latest *stable* tag while
  the binary is actually newer. `docker logs ytdlp-updater` always reports the
  true installed version.

## Deploying

### 1. Configure

```bash
cp .env.example .env
```

Edit `.env`. The two that matter most:

- **Paths** — point `APPDATA_PATH`, `VIDEO_PATH` etc. at the folders the existing
  deployment already uses, so nothing gets recreated empty. Relative paths
  resolve against this folder; Synology absolute paths look like
  `/volume1/docker/youtubedl-material`.
- **`PUID`/`PGID`** — must match the owner of `appdata/`, or the sidecar will
  write a binary the app cannot execute. The app image defaults to `1000:1000`.
  Confirm with:

  ```bash
  sudo stat -c '%u:%g' /volume1/docker/youtubedl-material/appdata/bin
  ```

  The sidecar refuses to start with a clear error rather than guessing if it
  cannot write there.

### 2. Validate the compose file over SSH first

Container Manager's bundled Compose has historically dropped keys its parser
does not recognise, silently. Check before importing:

```bash
sudo docker compose config
```

### 3. Bring it up

```bash
sudo docker compose up -d
```

Or import this folder as a Container Manager **Project**. If you do, check the
project's own autostart toggle in the Container Manager UI after a NAS reboot —
DSM tracks that separately from the Compose `restart:` policy.

### 4. Watch the first run

The sidecar waits `STARTUP_DELAY_SECONDS` (default 60s) before its first check,
so the app finishes its own boot-time binary check first instead of the two
racing over `appdata/bin`.

```bash
sudo docker compose logs -f ytdlp-updater
```

A first run on a fresh deployment looks like: resolve target version → back up
the existing binary → verified download → `--version` sanity check → record in
`youtube-dl.json`.

### Adopting an existing deployment

Point the paths in `.env` at the existing data, then bring the stack up in place.
The service names here (`ytdl_material`, `ytdl-mongo-db`, `container_name:
mongo-db`) match the upstream compose file, so a stack originally deployed from
it will be adopted rather than duplicated. Two things to confirm first:

- The Compose **project name** matches the existing one, or Docker will create a
  parallel set of containers. Container Manager derives it from the folder name;
  check with `sudo docker compose ls`.
- The existing app service does not set `UID`/`GID` env vars. This compose file
  deliberately does not either — changing them makes the app's entrypoint
  re-`chown` every mounted volume on next boot, which on a media library is slow
  and disruptive.

## Channels and flavors

`YTDLP_CHANNEL` — `stable` (default), `nightly`, `master`, or an exact version.

Site breakages get patched in nightly builds days before they reach a tagged
release, so `nightly` genuinely helps the "any random site should work" goal, at
the cost of occasional transient regressions. That is what the rollback path
below is for. Note the Settings-page caveat above.

`YTDLP_FLAVOR` — `standalone` (default) or `zip`.

- **`standalone`** installs `yt-dlp_linux`, a self-contained binary. It does not
  use the app image's `python3`, which matters: the app image ships Python 3.10,
  yt-dlp already emits a deprecation warning on it, and when support is dropped
  the zipapp will stop running entirely. The standalone binary is immune to that.
  Verified against a real release: a 40 MB dynamically-linked x86-64 ELF built
  for glibc 2.x, which the app's Ubuntu 22.04 base runs fine.
- **`zip`** installs the Python zipapp the app downloads by default. Pick it only
  if the standalone binary misbehaves.

The sidecar detects a flavor mismatch on disk and reinstalls, so switching is
just an `.env` change plus a container restart.

## Operating it

Run a check immediately instead of waiting for the interval:

```bash
sudo docker compose exec ytdlp-updater /opt/ytdlp-updater/update-ytdlp.sh
```

See what can be rolled back to:

```bash
sudo docker compose exec ytdlp-updater /opt/ytdlp-updater/rollback-ytdlp.sh --list
```

Roll back to the previous binary:

```bash
sudo docker compose exec ytdlp-updater /opt/ytdlp-updater/rollback-ytdlp.sh
```

A rollback writes a **hold** file. While it exists the sidecar will not move off
that version — otherwise the next cycle would reinstall the release you just
backed away from — and it will restore the held binary if the app's own updater
replaces it. Resume normal updates with:

```bash
sudo docker compose exec ytdlp-updater /opt/ytdlp-updater/rollback-ytdlp.sh --release
```

Roll back to a specific backup, or to the last binary that passed verification:

```bash
sudo docker compose exec ytdlp-updater /opt/ytdlp-updater/rollback-ytdlp.sh --to yt-dlp.2026.07.04.20260704-031500
```

```bash
sudo docker compose exec ytdlp-updater /opt/ytdlp-updater/rollback-ytdlp.sh --last-good
```

### Logs

| What | Where |
|---|---|
| Updater, live | `sudo docker compose logs -f ytdlp-updater` |
| Updater, persistent | `appdata/logs/ytdlp-updater.log` (trimmed to `LOG_MAX_LINES`) |
| App + yt-dlp output | `appdata/logs/combined.log`, `appdata/logs/error.log` |
| Backups | `appdata/bin/backups/`, plus `yt-dlp.bak` and `yt-dlp.last-good` |

### Safety properties

- Nothing unverified is installed. Both update paths check the download against
  the release's own `SHA2-256SUMS`; a mismatch or a missing checksum entry
  discards the file rather than installing it.
- The binary is swapped with `mv` on the same filesystem, so the app never
  observes a partially-written file.
- Every change is preceded by a backup, and a binary that fails `--version` — or
  the optional smoke test — is rolled back automatically.
- `flock` prevents a manual run and the scheduled loop from colliding.
- The sidecar mounts `appdata` only. It cannot touch the media volumes or the
  database.

## Pushover

Set `PUSHOVER_ENABLED=true` and fill in `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY`
in `.env` (which is gitignored). Notifications fire on update, failure, rollback,
and hold problems. "Already up to date" is silent unless
`PUSHOVER_NOTIFY_NOOP=true`. With the token blank and `PUSHOVER_ENABLED=false`,
everything works and simply logs instead.

Send a test:

```bash
sudo docker compose exec ytdlp-updater bash -c '. /opt/ytdlp-updater/lib/common.sh && notify "Test" "ytdlp-updater is wired up correctly."'
```

## Optional extras

`SMOKE_TEST_URL` — after each update, run a metadata-only `--simulate` against
one URL and roll back automatically if it fails. Nothing is downloaded. Off by
default because a geo-blocked or rate-limited test URL would cause false
rollbacks. Worth setting to something stable if downloads breaking silently is
the bigger worry.

`COOKIE_MAX_AGE_DAYS` — warns when `appdata/cookies.txt` gets stale. A large
share of "site not supported" failures are really expired-cookie auth walls on
sites yt-dlp supports perfectly well.

## Testing the GUI without Docker

Useful on a dev machine that can't run containers (some VM hosts do not expose
nested virtualisation, so Colima/Docker/Podman are not an option there). This
runs the *exact* code from the nightly image — pulled straight out of the image
layers via the registry API, `node_modules` and prebuilt frontend included, so
there is no npm install and no Angular build.

`scripts/fetch-app-for-local-test.sh` does the whole thing:

```bash
./scripts/fetch-app-for-local-test.sh ~/ytdl-nightly
```

```bash
cd ~/ytdl-nightly && ytdl_use_local_db=true node app.js
```

Then open <http://localhost:17442>. Note the app uses **hash routing** —
Settings is `/#/settings`, not `/settings`.

`use_local_db` is the app's default, so Mongo is not needed for a GUI test. Two
things behave differently from the NAS and are expected: the app's own updater
downloads the yt-dlp *zipapp*, which will not run if the host's `python3` is
older than 3.10 (macOS ships 3.9) — on the NAS the sidecar installs the
standalone binary instead, which has no such dependency; and downloads needing
ffmpeg will fail unless ffmpeg is on `PATH`.

Verified working on macOS / arm64 with Node 22, despite the image pinning
Node 16 — that pin only matters for building the frontend.

### Validating URLs against the site-detection fallback

The fallback that recovers pages yt-dlp cannot handle has its own harness, which
runs the same code the download pipeline uses without touching the queue:

```bash
cd ~/ytdl-nightly && node site-detection-cli.js "<url>" --baseline --ytdlp
```

`--baseline` reports whether yt-dlp already handles the URL (if it does, the
fallback never fires). `--ytdlp` runs yt-dlp against each candidate and reports
refused extensions plus the retry with `--compat-options allow-unsafe-ext`.
`--json` for machine-readable output.

To point detection at a page served from localhost, set
`SITE_DETECTION_ALLOW_PRIVATE=true`. It is an environment variable rather than a
config item deliberately — a GUI toggle for that would be an SSRF switch. It logs
a warning on startup. **Never set it on the NAS.**

Note the local test instance needs a yt-dlp that runs on macOS. The zipapp the app
downloads does not (macOS ships Python 3.9, yt-dlp needs ≥3.10), so install the
standalone build instead:

```bash
cd ~/ytdl-nightly/appdata/bin && curl -fsSL -o yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos && chmod +x yt-dlp
```

### Testing this fork's own changes

`scripts/sync-to-local-test.sh` copies this fork's `backend/` over that instance
and restarts it, so backend changes can be exercised without Docker and without an
npm install — `node_modules` comes from the image:

```bash
./scripts/sync-to-local-test.sh ~/ytdl-nightly
```

Frontend changes need a build first. Note `npm ci` **fails** on this repo:
`package.json` and `package-lock.json` are out of sync upstream (`Missing:
ajv@6.15.0 from lock file`). Use `npm install` instead:

```bash
npm install --legacy-peer-deps && npm run build
```

That writes to `backend/public` (gitignored), which the sync script then picks up.
The build works on Node 22 despite the Dockerfile pinning 16.14.2 and
`package.json` claiming 12.3.1 — both are stale. Expect sass deprecation warnings;
they are not errors.

The API rejects unauthenticated requests by closing the socket, which curl reports
as `Empty reply from server` rather than a status code. Pass the admin token
(hardcoded in `backend/app.js`) when poking at endpoints by hand:

```bash
curl -fsS "http://localhost:17442/api/ytdlpStatus?apiKey=<admin_token>"
```

## Troubleshooting

**Sidecar exits immediately with a permissions error.** `PUID`/`PGID` do not
match the owner of `appdata/`. The error message names the uid it ran as.

**Binary keeps reverting after an app restart.** `PIN_APP_UPDATER` is `false`, or
the sidecar could not reach the GitHub API to learn what version the app expects.
Both are logged explicitly.

**"Could not resolve the target version".** GitHub API rate limit (60/hr per IP,
unauthenticated). Set `GITHUB_TOKEN` in `.env`; no scopes are needed.

**Downloads fail at the merge step but metadata works.** That is ffmpeg, not
yt-dlp — its version is fixed when the app image is built and this sidecar does
not touch it. Fixing it means rebuilding the app image.

**A specific site never works, on any version.** Missing extractor rather than a
stale binary. yt-dlp can load third-party extractors from a plugins folder; that
is the escape hatch rather than working around it elsewhere.
