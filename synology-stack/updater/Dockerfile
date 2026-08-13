# yt-dlp updater sidecar.
#
# Deliberately tiny: it only needs to talk to GitHub, verify a checksum, and
# swap a file inside the shared appdata volume. It never runs the app.
#
# python3 is here for two reasons: it parses the GitHub API responses and
# appdata/youtube-dl.json without pulling in jq, and it is what runs the yt-dlp
# zipapp when YTDLP_FLAVOR=zip. The default 'standalone' flavor does not need it
# at runtime inside the app container.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        tzdata \
        util-linux \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY lib/ /opt/ytdlp-updater/lib/
COPY entrypoint.sh update-ytdlp.sh rollback-ytdlp.sh /opt/ytdlp-updater/
RUN chmod +x /opt/ytdlp-updater/*.sh

# Match the app's own view of the filesystem so the paths recorded in
# appdata/youtube-dl.json ("appdata/bin/yt-dlp") stay correct for both.
ENV APPDATA_DIR=/app/appdata

ENTRYPOINT ["/opt/ytdlp-updater/entrypoint.sh"]
CMD ["loop"]
