# PHP / Laravel port assessment

Assessment date: 2026-10-28. This is a source review of this repository, not a completed port or a test against a live zcoder server.

## Verdict

A functionally equivalent PHP or Laravel application is feasible. The upstream is an HTTP/JSON protocol, and nothing in the server-side implementation requires Node.js. The larger undertaking is the interactive client: it is a stateful console, not simply a collection of server-rendered forms. PHP can render HTML and serve the gateway, but browser JavaScript is still needed for polling, cancellation, queues, focus, and responsive interaction. The current application already emits HTML, CSS and JavaScript; using those standards does not itself require removing React.

For the lowest-risk migration, port the gateway first while retaining the existing React client and its API contract. If removing React is also a goal, replace it separately with modular browser JavaScript, keeping the existing CSS and behavior as the acceptance baseline. Laravel is a reasonable choice for established routing, middleware and testing; a small PHP application is also viable given the narrow backend. Laravel adds framework and operational overhead, so neither option is inherently faster or leaner without measurement. Do not assume a rewrite improves performance.

## What exists today

- `app/page.tsx`, `app/login/` and `components/login-form.tsx` provide the authenticated console and login, including a conventional form fallback.
- `components/console-app.tsx` (about 1,050 lines), `components/document-reader.tsx`, `lib/input-queue.ts`, `lib/client-rpc.ts` and `lib/visibility.ts` implement the browser experience. `app/globals.css` contains the existing responsive styling. This is the bulk of the behavioral port.
- `app/api/` exposes login, logout, a server list and one RPC endpoint per configured server. `lib/rpc.ts` validates and maps actions to fixed upstream endpoints; `lib/zcoder.ts` validates configuration and performs protocol requests. There is no application database in this repository: zcoder owns sessions and transcripts.
- `public/sw.js`, `public/offline.*`, `app/manifest.ts` and icons implement an installable PWA with a generic offline fallback. Private pages and API responses are deliberately not cached.
- Configuration comes from environment variables; upstream URLs and bearer tokens stay on the server. The application depends on an independently running zcoder protocol-1 server, not on a PHP-specific backend.

## Functionality that must survive

| Area | Existing behavior and port requirement |
| --- | --- |
| Connection and sessions | Discover configured servers, remember selection, show server/model details, create/select/load sessions, restore active runs, and load saved sessions in the background without blocking initial readiness. Respect capability flags and older servers. |
| Transcript and events | Load paginated transcript and poll events by advancing sequence cursor; retain ordering and avoid duplicates, retry transient errors and resume after visibility changes or restart. Preserve scroll position when the reader is away from the bottom, with a jump-to-latest control. |
| Turns and approvals | Model warm-up/readiness, prompt submission, streaming-style event updates through polling, cancellation, approval decisions and keyboard shortcuts. Scoped cancellation may continue queued work; older servers use ordinary cancellation. |
| Queued input | Steering and follow-up, exact-request persistence before sending, receipt reconciliation, retry with the same message ID, status/drop races, rejected and uncertain states, and session-wide resume. Stored messages are scoped by server and session. Storage failure must block new submission. Never parse the server's display-only pending text as structured records. |
| Documents and rendering | Up to four in-memory read-only Markdown tabs, canonical path identity, preserved scroll and draft, explicit reload, approval priority and capability fallback. Keep remote HTML/images inert and links constrained. |
| Mobile and accessibility | Responsive session drawer, focus management and trap, keyboard shortcuts, composer behavior on touch, status announcements, safe areas and keyboard resizing. Preserve desktop and phone interaction, not just appearance. |
| PWA | Install metadata/icons, production registration, conservative caching and offline screen; update the service worker's Next-specific static asset rules for the new asset paths. Existing installed clients must receive and activate the updated worker. |

The full client contract is best taken from the source and its tests, especially `components/console-startup.test.tsx`, `components/console-app.test.tsx`, `components/document-reader.test.tsx`, and `lib/input-queue.test.ts`. The README describes version-dependent queue and document capabilities.

## Gateway and security requirements

A PHP gateway should preserve the existing URLs, JSON shapes, status codes and `X-Zweb-Auth: required` response header if the existing client is retained. Implement the fixed action allowlist in `lib/rpc.ts`: hello, model get/ensure, session list/load/select/new, document read, turn start, input submit/list/status/drop, events next, approval and cancel. Do not accept a client-supplied upstream URL or arbitrary path.

Preserve validation and protocol details rather than relying on framework defaults: server IDs and token format, HTTP-only origin-only upstream URLs, flat JSON responses, 15-second upstream timeout, 2,000,000-byte response limit, 1,000,000-byte RPC body limit, and action-specific field limits. Session listing and transcript loading fetch one item per upstream request, require an advancing cursor, and stop at 500 and 10,000 items respectively; `after` must remain the last query parameter. Match upstream error handling and prevent credentials from reaching logs or responses. Check redirects explicitly so an upstream redirect cannot bypass the intended destination policy.

Reproduce Argon2id verification, a 12-hour HttpOnly, SameSite=Strict cookie with Secure in production, authentication on every API, and same-origin checks on mutations including login. A Laravel session or a PHP JWT implementation can replace the present signed JWT, but that changes session semantics unless deliberately handled. Either plan a one-time re-login at cutover or implement and test compatibility; keep the login form fallback. PHP's Argon2 support and existing hash verification must be verified on the target host. Reproduce bounded login bodies and escalating throttling; PHP-FPM workers do not share ordinary in-process state, so use a shared atomic cache or proxy limiter, with the same trusted-proxy assumptions. Maintain nonce CSP, security headers, HTTPS, and no-store behavior. Framework CSRF protection must be configured coherently with the existing origin checks and client requests.

## Architecture and operational tradeoffs

A practical Laravel layout is Blade for the shell and login, middleware for authentication, origin and headers, controllers for the existing endpoints, and a dedicated protocol client with strict validators. A plain PHP implementation needs the same boundaries, tests and secure defaults explicitly. Neither requires a database for parity; any chosen session or rate-limit store introduces its own availability and deployment requirements.

PHP-FPM occupies a worker while waiting for upstream HTTP. The current 15-second timeout and sequential one-item pagination mean a slow server or a long transcript can hold a worker for substantially longer than one request timeout. Browser event polling and multiple users compound this. Measure actual upstream latency, pagination sizes, worker occupancy, memory and p95 response time on the intended server; set proxy/FPM timeouts and capacity accordingly. Do not change protocol ordering or parallelize requests without establishing upstream safety. Test browser aborts, restarts and timeouts end to end. A PHP port does not remove the zcoder network, token, tunnel or reverse-proxy requirements.

The deployment instructions refer to `scripts/pm2-restart.sh`, but that script is absent from this checkout. A PHP deployment needs a reviewed replacement for build, configuration, FPM/web-server setup, restart and rollback; inspect the actual production host before assuming its capabilities. Keep the existing deployment available until cutover is validated.

## Recommended migration and acceptance

1. Capture current behavior using the existing tests and a representative real zcoder instance, including older capability combinations. Record API fixtures with secrets removed and benchmark realistic transcripts and polling.
2. Implement a PHP gateway behind the same API and run shared contract tests against both implementations. Test authentication, limits, malformed/oversized responses, timeouts, cursor progress, and secret isolation. Run the existing client against it before changing the UI.
3. If a React-free client is desired, port it incrementally to modules with explicit state and cancellation ownership. Preserve local-storage key and record format or provide a tested migration so pending submissions remain recoverable. Reuse CSS and assets where appropriate.
4. Exercise end-to-end workflows: login/logout/expiry; server switch and active-run reconnect; new and saved sessions; approval and cancel; queued submissions with lost responses, reload, retries, discard/consume races and storage failures; documents; offline/online and background/foreground; installed PWA upgrades; keyboard and mobile focus. Compare output and error behavior with the current app, using real upstream versions as well as controlled failure fixtures.
5. Load-test PHP worker capacity, verify production security headers and cookie behavior through the real proxy, then deploy alongside the existing application with a rollback path. Treat parity as demonstrated only after these checks pass.

## Scope and uncertainty

Backend-only replacement is a bounded project; a framework-free browser rewrite is materially larger and carries the highest regression risk. As a planning placeholder, allow several developer days for a gateway prototype and several weeks for a complete React-free port and parity testing; these are rough estimates, not commitments, and depend on upstream access, deployment setup, device coverage and discovered edge cases. No live server, production environment, browser/device matrix, performance benchmark or PHP prototype was evaluated for this report. Consequently feasibility is high, but zero lost functionality cannot be guaranteed until the acceptance suite and real deployment checks pass.
