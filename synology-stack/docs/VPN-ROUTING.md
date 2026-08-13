# Optional: routing yt-dlp traffic over a VPN

> **Status: built but NOT enabled.** No gluetun container exists, no network was
> created, and the app's VPN toggle is off. Until you follow the steps below,
> download traffic egresses exactly as it does now.

Gluetun raises its own WireGuard (or OpenVPN) tunnel and serves an HTTP proxy on
it. yt-dlp is pointed at that proxy from the app's Settings page, so turning it on
and off is a runtime setting rather than a compose change or a restart.

**Nothing here touches the NAS network.** No macvlan, no `docker network create`
over SSH, no router policy route, no changes to any existing interface or to any
existing macvlan network.

## Read this before you decide you want it

**VPN egress often makes site support worse, not better.** Datacenter and VPN IP
ranges attract stricter bot detection, rate limiting and CAPTCHA walls than a
a normal home connection does — YouTube especially. If the goal is "any random URL
should work", the NAS's normal IP is usually the *better* path, and
the VPN is worth reaching for only when a specific site is geo-blocked or is
blocking the home IP.

That is why this is a toggle rather than an always-on route: turn it on for the
sites that need it, leave it off the rest of the time.

## Why gluetun instead of reusing a router-level tunnel

The original plan was a proxy container with its own LAN IP on a macvlan, plus a
router policy route sending that IP out an existing tunnel. That works, but
gluetun is better here on four counts:

- **No NAS network changes at all.** The macvlan approach needs a macvlan network
  created over SSH (Container Manager's GUI cannot make them), and Docker rejects
  a second macvlan network whose subnet overlaps an existing one — so it would
  have meant joining whichever macvlan network is already defined.
- **No router policy route** to maintain, or to forget about while debugging later.
- **It fails closed.** This is the big one. Gluetun firewalls its own network
  namespace, so if the tunnel drops the proxy stops working and downloads fail
  loudly. The macvlan + policy-route design fails *open*: if the tunnel drops or
  the policy route is edited, traffic silently egresses the normal WAN on the ISP IP
  and nothing tells you.
- **No macvlan quirks.** Ordinary bridge networking and Docker DNS.

The cost is that it is a **second tunnel** rather than a reuse of a router one, so
the provider's WireGuard/OpenVPN credentials live in `.env` on the NAS.

If you ever need to reuse a router-level tunnel instead — for a site-to-site tunnel,
say, which gluetun is not built for — that design is written up in `HANDOFF.md`
§6a, including the two corrections that make it actually work.

## Prerequisites

- [ ] WireGuard (or OpenVPN) credentials from your provider. For WireGuard you
      need the **private key** and the **assigned address**; providers usually
      hand these out as a generated config file.
- [ ] `/dev/net/tun` available on the NAS. Check with:

      ```bash
      ls -l /dev/net/tun
      ```

      If it is missing, load it with `sudo insmod` / `sudo modprobe tun` — on DSM
      it is normally present already.
- [ ] `VPN_LINK_SUBNET` (default `172.31.250.0/24`) must not overlap your LAN
      subnet, any existing Docker network, or the VPN's own tunnel
      range. Check existing Docker subnets with:

      ```bash
      sudo docker network ls -q | xargs -n1 sudo docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
      ```

## Enabling it

1. Fill in the VPN section of `.env`: `VPN_SERVICE_PROVIDER`, `VPN_TYPE`,
   `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES`, and optionally
   `VPN_SERVER_COUNTRIES` / `VPN_SERVER_CITIES`. The exact variables differ per
   provider — check your provider's page under
   <https://github.com/qdm12/gluetun-wiki/tree/main/setup/providers>.

2. Validate the merged config without applying it:

   ```bash
   sudo docker compose -f docker-compose.yml -f docker-compose.vpn.yml config
   ```

3. Bring it up:

   ```bash
   sudo docker compose -f docker-compose.yml -f docker-compose.vpn.yml up -d
   ```

   Container Manager's Project GUI takes a single compose file, so enabling this
   is an SSH operation. The project will show as modified externally — expected.

4. Confirm the tunnel came up before trusting it:

   ```bash
   sudo docker logs gluetun | tail -30
   ```

   Look for a line reporting the assigned public IP. Then check what the proxy
   actually egresses as, from inside the app container:

   ```bash
   sudo docker exec -it ytdl_material sh -c 'curl -s -m 15 -x http://gluetun:8888 https://api.ipify.org; echo'
   ```

   Compare against the unproxied address:

   ```bash
   sudo docker exec -it ytdl_material sh -c 'curl -s -m 15 https://api.ipify.org; echo'
   ```

   Two different addresses means the proxy and tunnel are both working. **If the
   proxied command hangs instead of returning**, `FIREWALL_OUTBOUND_SUBNETS` does
   not match `VPN_LINK_SUBNET` — gluetun is accepting the connection and then
   dropping its own reply. They must be the same value.

5. Turn it on in the app: **Settings → Downloader → Route downloads through VPN**,
   with **VPN proxy URL** set to `http://gluetun:8888`. Save.

6. Verify a real download works, then test a couple of previously-problematic
   sites both with the toggle on and off before deciding it should stay on.

## Using the toggle

Once it is up, the toggle in Settings is the on/off switch — no restarts, no
compose changes. The backend adds `--proxy <url>` to every yt-dlp invocation
while it is on.

Two things worth knowing:

- A `--proxy` written by hand into **Global custom args** takes precedence over
  the toggle. That field is delimited by **two commas**, not spaces
  (`--proxy,,http://gluetun:8888`), because the backend splits on `,,`.
- **Subscriptions do not inherit the global args.** They carry their own custom
  args and have to be edited individually. The toggle *does* apply to them, since
  it is injected in the shared arg builder rather than in the global args string.

## Turning it back off

Flip the Settings toggle off. That is enough — the gluetun container can keep
running harmlessly.

To remove it completely:

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.vpn.yml down
```

```bash
sudo docker compose up -d
```

The second command brings the stack back up from the base compose file only,
which removes the gluetun container and the `vpn_link` network. Make sure the
Settings toggle is off first, or downloads will fail trying to reach a proxy that
no longer exists.
