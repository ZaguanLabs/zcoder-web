# zweb

A private, web-based control surface for one or more [`zcoder.zsh`](https://github.com/ZaguanLabs/zcoder.zsh) protocol-1 servers. The interface follows the original TUI: flat panels, compact server state, remote sessions, plain-text transcripts, model readiness, command approvals, and cancellation.

> **Note:** This web interface requires `zcoder.zsh` to be running. zcoder.zsh provides the backend protocol-1 servers that zweb connects to — the two projects are interlinked and zweb cannot function without it.

The browser never connects to zcoder directly. It talks only to this Next.js application; zweb reads upstream URLs and bearer tokens on the server from `.env.local`.

## Quick start

Requirements: Node.js 20.9 or newer and a reachable zcoder server (preferably through an SSH tunnel or private VPN).

```bash
pnpm install
cp .env.example .env.local
pnpm auth:hash
```

Paste the complete `APP_PASSWORD_HASH=...` output into `.env.local`. Generate the session secret:

```bash
openssl rand -base64 48
```

Put that value in `AUTH_SECRET`, set `APP_ORIGIN`, and configure the upstreams as a JSON array:

```dotenv
APP_USERNAME=operator
APP_PASSWORD_HASH=\$argon2id\$v=19\$m=65536,t=3,p=1\$...
AUTH_SECRET=a-long-random-value-from-openssl
APP_ORIGIN=https://zcoder.example.net
TRUST_PROXY_HEADERS=false
ZCODER_SERVERS_JSON='[
  {"id":"workshop","name":"Workshop Mac","url":"http://127.0.0.1:7337","token":"the-zcoder-token"},
  {"id":"lab","name":"Lab server","url":"http://127.0.0.1:7338","token":"the-other-zcoder-token"}
]'
```

Server IDs may contain lowercase letters, numbers, `_`, and `-`. Tokens must follow zcoder’s URL-safe 32-character minimum. Restart zweb after changing `.env.local`.

Run locally:

```bash
pnpm dev
```

For production:

```bash
pnpm build
pnpm start -H 127.0.0.1 -p 3000
```

Terminate TLS in a trusted reverse proxy in front of `127.0.0.1:3000`. Production cookies are `Secure`, so the public app must use HTTPS.

## Mobile and installation

zweb is a responsive Progressive Web App. On a phone, open the HTTPS production URL and use your browser's **Add to Home Screen** or **Install app** action. It opens as a standalone app with mobile safe-area support, touch-sized controls, a slide-over session list, and the same server selector available on desktop.

The service worker is deliberately conservative because zweb handles private systems:

- Authenticated pages, transcripts, prompts, API responses, and mutations are never cached.
- Only the generic offline screen, app icons, stylesheet, and immutable Next.js assets may be cached.
- When the network is unavailable, navigation shows a generic offline screen rather than stale session data.
- Service-worker registration is production-only. Installation requires HTTPS, except during browser-supported localhost development.

After changing the manifest, icons, or service worker, run a new production build and reload the installed app while online so it can update.

## Steering and follow-ups

With zcoder.zsh 0.12.0 or later advertising `input_queue: true`, the composer stays available during a run. Choose **Steering** to add guidance after the current model response and its tools, or **Follow-up** to queue another task after the current task finishes. Both use the existing run and event stream, including command approvals.

Queued cards show **Pending**, **Paused**, **Added to history**, **Discarded**, or **Unconfirmed**. Added to history means the input was consumed; it does not mean the model has answered it. Unconfirmed submissions retain their exact request and offer **Retry exact submission**. A rejected or malformed response leaves the draft available.

The browser saves queued requests and receipt states in local storage, scoped by configured server ID and session ID, before sending. These records include message text so retries can preserve exact bytes. They survive reloads; terminal cards can be dismissed to remove their local records. They are separate from the server-owned transcript and from service-worker caching. If browser storage is unavailable or full, new queue submissions are blocked before posting.

On reconnect, zweb loads the selected session, reconciles saved message IDs through `/v1/input/status`, and obtains the accepting run from `/v1/input/list`. The server listing is displayed as text: it cannot safely be parsed into individual messages, and user-message events do not contain IDs. Clearing browser storage loses per-message controls for those submissions; the listing and session-wide recovery remain available.

Stopping a run preserves unconsumed input. While idle in its original session, use **Resume pending input** to explicitly select that session and start `/queue resume`, or **Discard** a known pending card. Discard races are reconciled by status; they never claim to undo consumed input. Older servers keep active-run input as an unsent draft until a normal turn can start.

## Connecting zcoder safely

Protocol 1 sends the zcoder token, prompts, reasoning, commands, and transcripts over plain HTTP. Do not expose port 7337 publicly. A loopback SSH tunnel is the safest simple option:

```bash
ssh -N -L 127.0.0.1:7337:127.0.0.1:7337 operator@workshop
```

Then use `http://127.0.0.1:7337` in `ZCODER_SERVERS_JSON`. Assign another local port for each additional server. A private WireGuard or Tailscale path with restrictive firewall rules is also suitable.

## Security model

- Argon2id password verification; plaintext login passwords are never stored.
- Signed 12-hour `HttpOnly`, `Secure` (production), `SameSite=Strict` session cookie.
- Same-origin validation on every mutation, including login and zcoder RPC calls.
- Login throttling with escalating lockouts. It is process-local; for multiple zweb instances, add shared rate limiting at the reverse proxy.
- Per-request nonce-based CSP, frame blocking, MIME sniffing protection, minimal browser permissions, no referrer, and production HSTS.
- Every API route checks authentication independently.
- Fixed RPC allowlist: browsers cannot choose arbitrary upstream paths or URLs.
- Bounded browser request bodies and bounded zcoder responses.
- Zcoder URLs and bearer tokens never enter client bundles or API responses.

Set `TRUST_PROXY_HEADERS=true` only when a trusted reverse proxy overwrites `X-Forwarded-For` and clients cannot reach zweb directly. Otherwise all login attempts intentionally share one conservative rate-limit bucket.

The zcoder bearer token remains a server-wide capability. Anyone who obtains either `.env.local` or server process access can control that upstream. Restrict the file to the service account (`chmod 600 .env.local`), run zweb as an unprivileged user, and keep application/debug logs private.

## Commands

```bash
pnpm lint
pnpm test
pnpm build
pnpm auth:hash
```
