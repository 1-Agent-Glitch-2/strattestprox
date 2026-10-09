# Dual Proxy (Scramjet + Ultraviolet)

A single Node.js host that merges the two standalone proxy nodes in this workspace
(`SJ-Proxy/` for Scramjet and `UV-Proxy/` for Ultraviolet) into one app with an
in-page **Settings** panel for choosing which engine and transport to use.

## Run

```bash
npm install
npm start          # http://localhost:8080  (PORT=xxxx to change)
```

## Settings

Click the ⚙ button in the header:

- **Proxy engine** — `Scramjet` (modern WASM-rewritten proxy) or `Ultraviolet`
  (classic service-worker proxy). Saving switches engines: the other engine's
  service worker is unregistered, the page reloads, and the selected engine boots.
- **Transport** — `libcurl` or `epoxy`, both talking to the same `/wisp/` endpoint
  (wisp-server-node). Stored per engine, so each engine keeps its own last choice
  (stock pairings: Scramjet→libcurl, Ultraviolet→epoxy).
- **Search engine** — Google / DuckDuckGo / Bing fallback for non-URL input.
- **Reset proxy data** — unregisters all service workers, clears caches and
  saved settings.

All choices persist in `localStorage` (`dualproxy.settings`).

## How it fits together

| Path | Served from | Used by |
| --- | --- | --- |
| `/scram/`, `/controller/` | `@mercuryworkshop/scramjet`, `@mercuryworkshop/scramjet-controller` | Scramjet engine |
| `/uv/` | `@titaniumnetwork-dev/ultraviolet` (overridden `public/uv/uv.config.js` pins everything under `/uv/`) | Ultraviolet engine |
| `/baremux/`, `/epoxy/`, `/libcurl/` | bare-mux + transports (shared by both engines) | both |
| `/wisp/` (websocket) | `wisp-server-node` | both transports |
| everything else | `public/` | the UI |

Service workers never fight over the same scope: Scramjet registers `/sw.js`
(scope `/`), Ultraviolet registers `/uv/sw.js` (scope `/uv/`), and only the
selected engine's worker stays registered.

Two small bridges were needed because the vendors' transports disagree on header
shapes (both verified in-browser, all four engine × transport combinations load
`https://example.com/` through the proxy):

- Scramjet boot normalizes transport responses (`headers` pairs ↔ `rawHeaders`).
- Ultraviolet + libcurl installs a bare-mux `setManualTransport` adapter, since
  bare-mux sends header records while `LibcurlClient` iterates pairs.

## Layout

```
server.js            merged static server (both engines + COOP/COEP + wisp)
public/              merged UI: index.html, app.js (engine adapters + settings), sw.js
SJ-Proxy/            original standalone Scramjet node (reference)
UV-Proxy/            original standalone Ultraviolet node (reference)
```
