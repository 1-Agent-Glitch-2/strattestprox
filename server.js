import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import wisp from "wisp-server-node";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(root, "public");

// Scramjet engine assets
const controllerDir = resolve(root, "node_modules/@mercuryworkshop/scramjet-controller/dist");
const scramjetWasmPath = resolve(scramjetPath, "scramjet.wasm");

// Transport assets (used by both engines)
const libcurlDist = resolve(root, "node_modules/@mercuryworkshop/libcurl-transport/dist");
const libcurlWasmPath = require.resolve("libcurl.js/libcurl.wasm");
// epoxy-transport fetches "epoxy.wasm" relative to its dist, but the file ships in epoxy-tls.
const epoxyWasmCandidates = [
  resolve(dirname(epoxyPath), "..", "..", "epoxy-tls", "full", "epoxy.wasm"), // hoisted sibling
  resolve(dirname(epoxyPath), "..", "node_modules", "@mercuryworkshop", "epoxy-tls", "full", "epoxy.wasm"), // nested
  resolve(root, "node_modules/@mercuryworkshop/epoxy-tls/full/epoxy.wasm")
];
const epoxyWasmPath = epoxyWasmCandidates.find((candidate) => existsSync(candidate));
if (!epoxyWasmPath) console.warn("epoxy.wasm not found; the epoxy transport may fail to initialize");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

// Public files win over vendor mounts so we can override e.g. /uv/uv.config.js.
const mounts = [
  ["/scram/", scramjetPath],
  ["/controller/", controllerDir],
  ["/libcurl/", libcurlDist],
  ["/epoxy/", epoxyPath],
  ["/baremux/", baremuxPath],
  ["/uv/", uvPath]
];

// Files that are not physically inside their mount directory.
const specialFiles = {
  "/libcurl/libcurl.wasm": libcurlWasmPath,
  "/scram/wasm_bg.wasm": scramjetWasmPath,
  "/scram/scramjet.wasm": scramjetWasmPath
};
if (epoxyWasmPath) specialFiles["/epoxy/epoxy.wasm"] = epoxyWasmPath;

const noCachePaths = new Set(["/", "/index.html", "/app.js", "/style.css", "/sw.js", "/uv/uv.config.js"]);

function locate(pathname) {
  if (Object.hasOwn(specialFiles, pathname)) return specialFiles[pathname];
  const publicCandidate = resolve(publicDir, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  if (publicCandidate !== publicDir && publicCandidate.startsWith(publicDir + sep) && existsSync(publicCandidate)) {
    return publicCandidate;
  }
  for (const [prefix, directory] of mounts) {
    if (pathname.startsWith(prefix)) {
      const relative = decodeURIComponent(pathname.slice(prefix.length));
      const file = resolve(directory, relative);
      if (file !== directory && !file.startsWith(directory + sep)) return null;
      return file;
    }
  }
  if (pathname === "/") return resolve(publicDir, "index.html");
  return publicCandidate;
}

const server = createServer((req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  let file;
  try {
    file = locate(pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": noCachePaths.has(pathname) ? "no-cache" : "public, max-age=3600"
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
});

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === "/wisp/") wisp.routeRequest(req, socket, head);
  else socket.end();
});

const port = Number.parseInt(process.env.PORT || "8080", 10);
server.listen(port, process.env.HOST || "0.0.0.0", () => {
  const address = server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  console.log(`Dual proxy (Scramjet + Ultraviolet) running at http://localhost:${listeningPort}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
