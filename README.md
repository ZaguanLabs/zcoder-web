# zweb

A private, web-based control surface for one or more `zcoder.zsh` protocol-1 servers. The interface follows the original TUI: flat panels, compact server state, remote sessions, plain-text transcripts, model readiness, command approvals, and cancellation.

The browser never connects to zcoder directly. It talks only to this Next.js application; zweb reads upstream URLs and bearer tokens on the server from `.env.local`.

## Quick start

Requirements: Node.js 20.9 or newer and a reachable zcoder server (preferably through an SSH tunnel or private VPN).

```bash
npm install
cp .env.example .env.local
npm run auth:hash
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
npm run dev
```

For production:

```bash
npm run build
npm start -- -H 127.0.0.1 -p 3000
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
npm run lint
npm test
npm run build
npm run auth:hash
```
