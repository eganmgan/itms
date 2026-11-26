# ITMS Mattermost

This is a separate Mattermost service; it does not replace ITMS. When same-window embedding is enabled, ITMS Nginx proxies the Mattermost LAN endpoint while the service remains bound to loopback. PostgreSQL and Mattermost data use dedicated persistent Docker volumes, and PostgreSQL is not published to the host.

The approved LAN address is `http://10.10.20.203:8065`. This is plain HTTP: credentials and messages are not encrypted in transit. Keep this port on the trusted internal network only; do not expose it to the internet.

## Initial setup

1. Keep `MM_BIND_ADDR=127.0.0.1` and `MM_SITE_URL=http://127.0.0.1:8065` in the private environment file for the first startup. Create that file outside the repository with mode `0600`; set `MM_DB_PASSWORD` to a unique random value.
2. Start the stack from the repository root:

   ```sh
   docker compose --env-file /home/itms/.local/share/itms-mattermost/.env \
     -f deploy/mattermost/compose.yml up -d --wait
   ```

3. While the port is still bound to localhost, create the initial system administrator with the bundled `mmctl` using local mode (`--local user create ... --system-admin`). Generate a unique password and keep it in a mode-`0600` file outside the repository; do not put it in shell history or send it in chat.
4. Create the `itms` team and its default `town-square` channel with `mmctl`, then verify the administrator can sign in.
5. After setup, keep Mattermost bound to loopback and put it behind the ITMS Nginx proxy. Set the private environment file to:

   ```dotenv
   MM_BIND_ADDR=127.0.0.1
   MM_HOST_PORT=8066
   MM_SITE_URL=http://10.10.20.203:8065
   ```

6. Install `deploy/nginx/mattermost-embed.conf` as `/etc/nginx/sites-enabled/mattermost-embed`, test the Nginx configuration, and reload Nginx. The proxy exposes Mattermost only on the approved LAN address and permits framing only by the ITMS origin `http://10.10.20.203`. It removes Mattermost's frame-blocking headers only on this proxy route and replaces its CSP with the existing `script-src 'self'` policy plus the exact ITMS `frame-ancestors` allowlist.
7. Recreate only the Mattermost service with the same Compose command. Users on the LAN can then open `http://10.10.20.203:8065`; the container itself remains reachable only on loopback port 8066.

The server's local mode is enabled only to support administrative commands through its local socket. Self-registration stays disabled; a system administrator must create accounts for coworkers. SMTP is not configured, so email invitations and password-reset emails are unavailable. Mattermost iframe embedding is an unsupported integration and should remain limited to the trusted private network; this HTTP deployment does not encrypt credentials or messages in transit. Do not expose port 8065 to the internet.

## Optional ITMS message history

After deploying a backend that supports inbound Mattermost sync, create an outgoing webhook in Mattermost's integrations settings. Scope it to `town-square`, select `application/x-www-form-urlencoded`, and leave trigger words empty to forward every post in that channel. Set its callback to the ITMS webhook endpoint and save the generated token in the backend's private environment as `MATTERMOST_INBOUND_WEBHOOK_TOKEN`; also set `MATTERMOST_INBOUND_ENABLED=true` and `MATTERMOST_INBOUND_CHANNEL_ID` to the channel's ID. Do not put the token in source control or a URL. Private callback addresses must be permitted in Mattermost's trusted internal connections setting; allow only the required address. The ITMS history feed is visible to signed-in users and mirrors text posts only; files and later edits remain available in Mattermost, and deleted posts remain in the ITMS copy.

## Persistence

The Compose file uses named volumes prefixed `itms-mattermost-`. Do not use `docker compose down -v` or remove these volumes during routine restarts; doing so deletes chat data. Back up the database and `itms-mattermost-data` volume before upgrades.

## Standalone sync service

`sync-compose.yml` builds a separate service and PostgreSQL volume; it does not replace the ITMS backend or run migrations against the ITMS database. It reuses the inbound webhook and history handlers. The history endpoint verifies every bearer token by calling the live backend's `/api/auth/me`; authentication errors fail closed. This adds one authentication request per history refresh, so assess the live backend's rate limit and expected concurrent users before deployment. An unavailable or rate-limited backend makes the history unavailable.

This service alone does not install a frontend or change nginx. Production deployment requires an administrator to configure same-origin routing for `/api/integrations/mattermost/messages`, allow the precise webhook callback host in Mattermost's trusted internal connections, and deploy a compatible frontend without replacing unrelated live assets. Configure the Mattermost webhook callback as `http://itms-mattermost-sync:3002/api/integrations/mattermost/webhook` on the shared Mattermost Docker network. Preserve existing TLS, authentication and frame protections. The provided service port binds only to localhost; do not expose it directly.

Use a private mode-`0600` environment file outside the repository containing `SYNC_DB_PASSWORD`, `SYNC_DATABASE_URL` (a PostgreSQL URL for user `mattermost_sync`, host `sync-db`, database `mattermost_sync`, and the same password; percent-encode special characters), `MATTERMOST_INBOUND_WEBHOOK_TOKEN`, `MATTERMOST_INBOUND_CHANNEL_ID`, and `ITMS_AUTH_URL` (the trusted backend's internal `/api/auth/me` URL). Set `MATTERMOST_RECOVERY_URL` to the Mattermost internal origin, `MATTERMOST_RECOVERY_LOGIN` and `MATTERMOST_RECOVERY_PASSWORD` to a dedicated non-admin channel member, and `MATTERMOST_RECOVERY_START` to a UTC RFC3339 timestamp recorded before enabling the webhook. A normal Mattermost account may also access other public channels in its team; restrict the account and its credentials appropriately. Never put secrets in source control. The `backend_default` and `mattermost_default` external networks and hostnames must match the target deployment. The sync service joins both networks and must be trusted as part of each. Internal HTTP transmits credentials and messages without encryption.

After addressing the routing, authentication-load, and frontend requirements above, start the isolated stack from the repository root with:

```sh
docker compose --env-file /path/to/private-sync.env -f deploy/mattermost/sync-compose.yml up -d --build --wait
```

The dedicated database schema is initialized only on first creation of the volume. Back up that volume before upgrades and never remove it during routine restarts. Recovery polls for posts since the saved watermark every minute, retries failed scans, and audits the history since the configured start time daily. Duplicate posts are ignored. Recovery logs errors and `/healthz` returns 503 until a scan succeeds or when no scan has succeeded for five minutes. Verify this endpoint before enabling the webhook and monitor it afterward.

Recovery can only fetch posts still available to the recovery account. Posts deleted before they are recovered cannot be restored; later edits, deletions and attachments are not mirrored. Large channel histories make daily audits more expensive and API rate limiting or persistent failures can delay recovery. Review retention, monitoring and expected load before deployment.
