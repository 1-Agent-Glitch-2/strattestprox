"use strict";

const HOME_URL = "https://example.com/";

const SEARCH_ENGINES = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  bing: "https://www.bing.com/search?q=%s"
};

const STOCK_TRANSPORT = { scramjet: "libcurl", ultraviolet: "epoxy" };

const DEFAULT_SETTINGS = {
  engine: "scramjet",
  transports: { scramjet: "libcurl", ultraviolet: "epoxy" },
  search: "google"
};

const ENGINE_LABELS = { scramjet: "Scramjet", ultraviolet: "Ultraviolet" };

const form = document.querySelector("#address-form");
const address = document.querySelector("#address");
const frameElement = document.querySelector("#browser");
const status = document.querySelector("#status");
const notice = document.querySelector("#notice");
const engineLabel = document.querySelector("#engine-label");

const settingsBackdrop = document.querySelector("#settings-backdrop");
const settingsOpen = document.querySelector("#settings-open");
const settingsCancel = document.querySelector("#settings-cancel");
const settingsSave = document.querySelector("#settings-save");
const settingsReset = document.querySelector("#settings-reset");
const settingsSearch = document.querySelector("#settings-search");
const engineRadios = () => document.querySelectorAll('input[name="engine"]');
const transportRadios = () => document.querySelectorAll('input[name="transport"]');

const wispUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/wisp/`;

let settings = loadSettings();
let adapter = null;
let shownEngine = settings.engine;

function loadSettings() {
  try {
    const raw = localStorage.getItem("dualproxy.settings");
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        transports: { ...DEFAULT_SETTINGS.transports, ...(parsed.transports || {}) }
      };
    }
  } catch (error) {
    console.warn("Could not read saved settings", error);
  }
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function persistSettings() {
  localStorage.setItem("dualproxy.settings", JSON.stringify(settings));
}

function showError(error) {
  notice.textContent = error instanceof Error ? error.message : String(error);
  notice.hidden = false;
  status.textContent = "Failed";
  console.error(error);
}

function setStatus(text) {
  status.textContent = text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function transportModulePath(engine) {
  const transport = settings.transports[engine] || STOCK_TRANSPORT[engine];
  return transport === "epoxy" ? "/epoxy/index.mjs" : "/libcurl/index.mjs";
}

function toUrl(input) {
  const text = input.trim();
  if (!text) return "";
  try {
    return new URL(text).href;
  } catch {}
  try {
    const candidate = new URL(`https://${text}`);
    if (candidate.hostname.includes(".")) return candidate.href;
  } catch {}
  const template = SEARCH_ENGINES[settings.search] || SEARCH_ENGINES.google;
  return template.replace("%s", encodeURIComponent(text));
}

async function waitForActive(registration, timeoutMs = 10000) {
  if (registration.active) return registration.active;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registration.active) return registration.active;
    await delay(100);
  }
  throw new Error("The service worker did not activate in time. Reload this page once.");
}

async function waitForController(timeoutMs = 4000) {
  if (navigator.serviceWorker.controller) return;
  await Promise.race([
    new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    }),
    delay(timeoutMs)
  ]);
}

// --- Scramjet engine -------------------------------------------------------

async function bootScramjet() {
  setStatus("Loading Scramjet…");
  await loadScript("/scram/scramjet.js");
  await loadScript("/controller/controller.api.js");

  const [controllerModule, transportModule] = await Promise.all([
    import("/controller/controller-external.mjs"),
    import(transportModulePath("scramjet"))
  ]);

  setStatus("Registering Scramjet service worker…");
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await waitForActive(registration);
  if (!navigator.serviceWorker.controller) await waitForController();
  const serviceWorker = navigator.serviceWorker.controller || registration.active;
  if (!serviceWorker) throw new Error("The Scramjet service worker did not activate. Reload this page once.");

  setStatus("Starting transport…");
  const Transport = transportModule.default;
  const transport = new Transport({ wisp: wispUrl });
  if (typeof transport.init === "function") await transport.init();

  // Scramjet iterates transport response headers as raw [key, value] pairs and
  // also reads `rawHeaders`. libcurl returns `headers` as an array already;
  // epoxy returns a plain object, so normalize both shapes here.
  const innerRequest = transport.request.bind(transport);
  transport.request = async (...args) => {
    const response = await innerRequest(...args);
    if (response && typeof response === "object") {
      let headers = response.headers;
      if (headers && !Array.isArray(headers)) {
        if (typeof headers.entries === "function") headers = Array.from(headers.entries());
        else if (typeof headers === "object") headers = Object.entries(headers);
      }
      if (Array.isArray(headers)) {
        response.headers = headers;
        if (response.rawHeaders === undefined) response.rawHeaders = headers;
      }
    }
    return response;
  };

  const controller = new controllerModule.Controller({
    serviceworker: serviceWorker,
    transport,
    config: {
      scramjetPath: "/scram/scramjet.js",
      injectPath: "/controller/controller.inject.js",
      wasmPath: "/scram/scramjet.wasm"
    }
  });
  await controller.wait();

  const frame = controller.createFrame(frameElement);
  adapter = {
    go: (url) => frame.go(url),
    back: () => frame.back(),
    forward: () => frame.forward(),
    reload: () => frame.reload()
  };
}

// bare-mux sends request headers to transports as plain records, but LibcurlClient
// iterates them as pairs; and Ultraviolet reads transport responses with header
// records while libcurl returns [key, value] pairs. This adapter bridges both.
const LIBCURL_BAREMUX_ADAPTER = `
const mod = await import("/libcurl/index.mjs");
const Libcurl = mod.default;
class AdaptedLibcurl {
  constructor(cfg) { this.inner = new Libcurl(cfg); }
  async init() { if (this.inner.init) await this.inner.init(); }
  async request(remote, method, body, headers, signal) {
    let h = headers;
    if (h && typeof h[Symbol.iterator] !== "function") h = new Headers(Object.entries(h));
    const res = await this.inner.request(remote, method, body, h, signal);
    if (res && Array.isArray(res.headers)) {
      const record = {};
      for (const pair of res.headers) {
        const key = String(pair[0]).toLowerCase();
        const value = pair[1];
        if (key in record) {
          record[key] = Array.isArray(record[key]) ? record[key].concat([value]) : [record[key], value];
        } else {
          record[key] = value;
        }
      }
      res.headers = record;
    }
    return res;
  }
  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    return this.inner.connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
  }
}
return [AdaptedLibcurl, "/libcurl/index.mjs"];
`;

// --- Ultraviolet engine ----------------------------------------------------

async function bootUltraviolet() {
  setStatus("Loading Ultraviolet…");
  await loadScript("/baremux/index.js");
  await loadScript("/uv/uv.bundle.js");
  await loadScript("/uv/uv.config.js");

  const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
  const wanted = transportModulePath("ultraviolet");
  const current = await connection.getTransport().catch(() => null);
  if (wanted.endsWith("libcurl/index.mjs")) {
    // Always (re)apply: the SharedWorker survives reloads and may hold a
    // previously configured non-adapted libcurl client.
    setStatus("Starting transport…");
    await connection.setManualTransport(LIBCURL_BAREMUX_ADAPTER, [{ wisp: wispUrl }]);
  } else if (current !== wanted) {
    setStatus("Starting transport…");
    await connection.setTransport(wanted, [{ wisp: wispUrl }]);
  }

  setStatus("Registering Ultraviolet service worker…");
  const registration = await navigator.serviceWorker.register("/uv/sw.js", { scope: "/uv/" });
  await waitForActive(registration);

  adapter = {
    go: (url) => {
      frameElement.src = self.__uv$config.prefix + self.__uv$config.encodeUrl(url);
    },
    back: () => frameElement.contentWindow?.history.back(),
    forward: () => frameElement.contentWindow?.history.forward(),
    reload: () => frameElement.contentWindow?.location.reload()
  };
}

// --- Boot ------------------------------------------------------------------

async function start() {
  try {
    if (!window.isSecureContext) {
      throw new Error("Service workers require HTTPS or localhost. Open this app at http://localhost:8080.");
    }
    const engine = settings.engine === "ultraviolet" ? "ultraviolet" : "scramjet";
    engineLabel.textContent = ENGINE_LABELS[engine];
    if (engine === "ultraviolet") await bootUltraviolet();
    else await bootScramjet();

    address.value = HOME_URL;
    adapter.go(HOME_URL);
    setStatus("Ready");
    notice.hidden = true;
  } catch (error) {
    showError(error);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = toUrl(address.value);
  if (!url) return;
  notice.hidden = true;
  if (!adapter) {
    showError(new Error("The proxy is still starting. Please try again in a moment."));
    return;
  }
  adapter.go(url);
  setStatus("Loading…");
});

document.querySelector("#back").addEventListener("click", () => adapter?.back());
document.querySelector("#forward").addEventListener("click", () => adapter?.forward());
document.querySelector("#reload").addEventListener("click", () => adapter?.reload());
frameElement.addEventListener("load", () => {
  if (adapter) setStatus("Ready");
});

// --- Settings --------------------------------------------------------------

function checkedValue(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
}

function setChecked(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
    radio.checked = radio.value === value;
  });
}

function openSettings() {
  shownEngine = settings.engine;
  setChecked("engine", shownEngine);
  setChecked("transport", settings.transports[shownEngine] || STOCK_TRANSPORT[shownEngine]);
  settingsSearch.value = settings.search;
  settingsBackdrop.hidden = false;
}

function closeSettings() {
  settingsBackdrop.hidden = true;
}

async function unregisterInactiveEngines(activeEngine) {
  const rootScope = new URL("/", location.href).href;
  const uvScope = new URL("/uv/", location.href).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const registration of registrations) {
    const isScramjet = registration.scope === rootScope;
    const isUltraviolet = registration.scope === uvScope;
    const isOtherEngine = activeEngine === "scramjet" ? isUltraviolet : isScramjet;
    if (isOtherEngine) await registration.unregister().catch(() => {});
  }
}

settingsOpen.addEventListener("click", openSettings);
settingsCancel.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", (event) => {
  if (event.target === settingsBackdrop) closeSettings();
});

engineRadios().forEach((radio) => {
  radio.addEventListener("change", () => {
    shownEngine = radio.value;
    setChecked("transport", settings.transports[shownEngine] || STOCK_TRANSPORT[shownEngine]);
  });
});

settingsSave.addEventListener("click", async () => {
  const engine = checkedValue("engine") || settings.engine;
  const transport = checkedValue("transport") || STOCK_TRANSPORT[engine];
  const search = settingsSearch.value;
  const engineChanged = engine !== settings.engine;
  const transportChanged = transport !== (settings.transports[engine] || STOCK_TRANSPORT[engine]);

  settings.engine = engine;
  settings.transports[engine] = transport;
  settings.search = search;
  persistSettings();
  closeSettings();

  if (engineChanged || transportChanged) {
    setStatus("Applying settings…");
    await unregisterInactiveEngines(engine);
    location.reload();
    return;
  }
  engineLabel.textContent = ENGINE_LABELS[settings.engine];
});

settingsReset.addEventListener("click", async () => {
  settingsReset.disabled = true;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => {})));
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key).catch(() => {})));
    localStorage.removeItem("dualproxy.settings");
    sessionStorage.clear();
  } finally {
    location.reload();
  }
});

start();
