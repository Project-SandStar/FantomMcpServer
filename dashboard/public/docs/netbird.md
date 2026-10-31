# NetBird

The NetBird tab on the Settings page (`/dashboard/config/#netbird`) connects this Fantom MCP server to the NetBird network.
The server then has its own name in your NetBird network, for example `fantom.netbird.example.com`.

## How to connect

1. Open your NetBird admin (for example `https://netbird.example.com`, or `https://app.netbird.io` for NetBird cloud) and go to **Setup Keys**.
2. Make a new setup key. Copy it.
3. In this dashboard, open **Settings > NetBird** (`/dashboard/config/#netbird`).
4. Paste the key in **Setup key**.
5. Check **Hostname** (default `fantom`) and **Management URL** (default `https://api.netbird.io:443`, the NetBird cloud; for a self-hosted
   server enter its address, for example `https://netbird.example.com:443`).
   The server admin can set the default with the `NETBIRD_MANAGEMENT_URL` environment variable.
6. Turn on **Enable NetBird** and click **Save**.

After about 10 seconds the status shows **Connected**, the name and the NetBird IP.

## Notes

- The page never shows the full key. It shows only the last 4 characters.
- To change the name, edit **Hostname** and click **Save**. The container reconnects.
- **Remove key** deletes the key and turns NetBird off.
- **Container missing** means the `fantom-netbird` service is not in the Docker stack
  (see `deploy/docker-compose.yml`). You can still save the settings.

## HTTPS

The **HTTPS** part serves this server as `https://<hostname>.<domain>`
(for example `https://fantom.example.com`) on the NetBird IP.

1. In Cloudflare, make an API token with the **Edit zone DNS** template, for the
   zone of your domain only (for example `example.com`).
2. Turn on **Enable HTTPS**, enter **Domain** (for example `example.com`; the
   default comes from `NETBIRD_HTTPS_DOMAIN`, else empty), paste the
   token and click **Save**.
3. After about a minute the HTTPS status shows **Running** and the certificate
   name and expiry date.

The page shows only the last 4 characters of the token. **Remove token** deletes it.
Without a token, the `fantom-caddy` container waits and serves nothing.

## Advanced

**WireGuard port**: default `0` (NetBird picks a free port). Set a fixed port
only when two peers on one host clash.

## How it works

The `fantom-netbird` and `fantom-caddy` containers share the folder `/netbird-ctl` with the Fantom
container. The dashboard writes `config.json` there. The script
`docker/netbird-entrypoint.sh` reads it, runs `netbird up`, and writes
`status.json` every 10 seconds. `docker/caddy-entrypoint.sh` reads the
`https` part, runs Caddy and writes `caddy-status.json`. Both use the Fantom
container network, so the NetBird IP reaches port 3848 and 443 directly.
If the Fantom container restarts, both sidecars exit and Docker restarts them
in the new network.
