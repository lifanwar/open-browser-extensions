const states = new Map();
const MAX_ENTRIES = 300;
const SUPPORTED_PROTOCOL_VERSIONS = ["1.3", "1.2", "1.1"];
const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_KEY_RE = /(password|passwd|passcode|secret|token|api[_-]?key|authorization|cookie|session|credential|otp|totp)/i;

function stateFor(tabId) {
  if (!states.has(tabId)) {
    states.set(tabId, {
      attached: false,
      capturing: false,
      captureBodies: true,
      pageHost: "",
      entries: new Map(),
      order: []
    });
  }
  return states.get(tabId);
}

export async function startNetwork(tabId, options = {}) {
  const state = stateFor(tabId);
  const tab = await chrome.tabs.get(tabId);
  state.pageHost = safeHost(tab.url);
  state.captureBodies = options.captureBodies !== false;

  if (!state.attached) {
    let attachedVersion = "";
    let lastError = null;
    for (const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS) {
      try {
        await chrome.debugger.attach({ tabId }, protocolVersion);
        attachedVersion = protocolVersion;
        state.attached = true;
        state.protocolVersion = protocolVersion;
        break;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error);
        if (/Another debugger|already attached|target is already being debugged/i.test(message)) {
          throw new Error("Tab sedang digunakan oleh DevTools atau debugger lain.");
        }
        if (!/protocol version|not supported|incompatible/i.test(message)) throw error;
      }
    }
    if (!attachedVersion) {
      throw new Error(`Debugger tidak dapat dipasang. Versi CDP yang dicoba: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}. ${String(lastError?.message || lastError || "")}`);
    }
  }

  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
    maxTotalBufferSize: 50_000_000,
    maxResourceBufferSize: 10_000_000,
    maxPostDataSize: 5_000_000
  });
  state.capturing = true;
  return { attached: true, capturing: true, host: state.pageHost, captureBodies: state.captureBodies, protocolVersion: state.protocolVersion };
}

export async function stopNetwork(tabId) {
  const state = stateFor(tabId);
  if (state.attached) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
  }
  state.attached = false;
  state.capturing = false;
  return { attached: false, capturing: false };
}

export function clearNetwork(tabId) {
  const state = stateFor(tabId);
  state.entries.clear();
  state.order.length = 0;
  return { cleared: true };
}

export function getNetwork(tabId, filters = {}, settings = {}) {
  const state = stateFor(tabId);
  const limit = Math.max(1, Math.min(100, Number(filters.limit || 30)));
  const urlFilter = String(filters.url_filter || "").toLowerCase();
  const methodFilter = String(filters.method_filter || "").toUpperCase();
  const resourceType = String(filters.resource_type || "").toLowerCase();
  const includeHeaders = filters.include_headers !== false;
  const includeBodies = filters.include_bodies !== false;
  const allowSensitive = Boolean(settings.revealSensitiveOnCurrentHost);

  const rows = state.order
    .map((id) => state.entries.get(id))
    .filter(Boolean)
    .filter((entry) => !urlFilter || entry.url.toLowerCase().includes(urlFilter))
    .filter((entry) => !methodFilter || entry.method === methodFilter)
    .filter((entry) => !resourceType || String(entry.resourceType || "").toLowerCase() === resourceType)
    .slice(-limit)
    .reverse()
    .map((entry) => serializeEntry(entry, {
      includeHeaders,
      includeBodies,
      reveal: allowSensitive && sameHostOrSubdomain(safeHost(entry.url), state.pageHost)
    }));

  return {
    attached: state.attached,
    capturing: state.capturing,
    currentHost: state.pageHost,
    sensitiveMode: allowSensitive,
    count: rows.length,
    requests: rows
  };
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!source.tabId) return;
  const state = states.get(source.tabId);
  if (!state?.capturing) return;

  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    const entry = state.entries.get(params.requestId) || { requestId: params.requestId };
    Object.assign(entry, {
      url: request.url || "",
      method: request.method || "GET",
      requestHeaders: request.headers || {},
      requestBody: request.postData,
      resourceType: params.type || "",
      startedAt: params.wallTime || Date.now() / 1000
    });
    state.entries.set(params.requestId, entry);
    if (!state.order.includes(params.requestId)) state.order.push(params.requestId);
    trimState(state);
  }

  if (method === "Network.requestWillBeSentExtraInfo") {
    const entry = state.entries.get(params.requestId) || { requestId: params.requestId, url: "", method: "" };
    entry.requestHeaders = { ...(entry.requestHeaders || {}), ...(params.headers || {}) };
    state.entries.set(params.requestId, entry);
  }

  if (method === "Network.responseReceived") {
    const response = params.response || {};
    const entry = state.entries.get(params.requestId) || { requestId: params.requestId, url: response.url || "", method: "" };
    Object.assign(entry, {
      url: entry.url || response.url || "",
      status: response.status,
      statusText: response.statusText,
      mimeType: response.mimeType,
      protocol: response.protocol,
      responseHeaders: response.headers || {},
      resourceType: params.type || entry.resourceType || ""
    });
    state.entries.set(params.requestId, entry);
  }

  if (method === "Network.responseReceivedExtraInfo") {
    const entry = state.entries.get(params.requestId) || { requestId: params.requestId, url: "", method: "" };
    entry.responseHeaders = { ...(entry.responseHeaders || {}), ...(params.headers || {}) };
    entry.status = entry.status ?? params.statusCode;
    state.entries.set(params.requestId, entry);
  }

  if (method === "Network.loadingFinished") {
    const entry = state.entries.get(params.requestId);
    if (!entry) return;
    entry.encodedDataLength = params.encodedDataLength;
    entry.finishedAt = Date.now() / 1000;
    if (state.captureBodies && isTextual(entry.mimeType)) {
      try {
        const body = await chrome.debugger.sendCommand(
          { tabId: source.tabId },
          "Network.getResponseBody",
          { requestId: params.requestId }
        );
        // Ponytail: truncate at storage time so raw bodies don't stay unbounded in memory.
        const raw = body?.body;
        entry.responseBody = raw != null && raw.length > 200_000 ? `${raw.slice(0, 200_000)}\n[TRUNCATED]` : raw;
        entry.responseBodyBase64 = Boolean(body?.base64Encoded);
      } catch {
        entry.responseBodyUnavailable = true;
      }
    }
  }

  if (method === "Network.loadingFailed") {
    const entry = state.entries.get(params.requestId);
    if (entry) entry.errorText = params.errorText || "Network request failed";
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (!source.tabId) return;
  const state = states.get(source.tabId);
  if (state) {
    state.attached = false;
    state.capturing = false;
  }
});

// Ponytail: prune state when tab closes so states Map doesn't grow unbounded.
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  if (state?.attached) {
    try { chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
  }
  states.delete(tabId);
});

function trimState(state) {
  while (state.order.length > MAX_ENTRIES) {
    const oldest = state.order.shift();
    state.entries.delete(oldest);
  }
}

function serializeEntry(entry, options) {
  const output = {
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    statusText: entry.statusText,
    resourceType: entry.resourceType,
    mimeType: entry.mimeType,
    protocol: entry.protocol,
    encodedDataLength: entry.encodedDataLength,
    errorText: entry.errorText
  };
  if (options.includeHeaders) {
    output.requestHeaders = sanitizeHeaders(entry.requestHeaders, options.reveal);
    output.responseHeaders = sanitizeHeaders(entry.responseHeaders, options.reveal);
  }
  if (options.includeBodies) {
    output.requestBody = sanitizeBody(entry.requestBody, options.reveal);
    output.responseBody = sanitizeBody(entry.responseBody, options.reveal);
    output.responseBodyBase64 = entry.responseBodyBase64;
  }
  return output;
}

function sanitizeHeaders(headers, reveal) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = !reveal && SENSITIVE_HEADER_RE.test(key) ? "[REDACTED]" : value;
  }
  return output;
}

function sanitizeBody(body, reveal) {
  if (body == null) return body;
  const text = String(body);
  const bounded = text.length > 200_000 ? `${text.slice(0, 200_000)}\n[TRUNCATED]` : text;
  if (reveal) return bounded;
  try {
    const parsed = JSON.parse(bounded);
    return JSON.stringify(redactObject(parsed));
  } catch {
    return bounded
      .replace(/(["']?(?:password|passwd|passcode|secret|token|api[_-]?key|authorization|session|credential|otp|totp)["']?\s*[:=]\s*)[^&\s,}\]]+/gi, "$1[REDACTED]")
      .slice(0, 200_000);
  }
}

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactObject(child);
  }
  return output;
}

function safeHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function sameHostOrSubdomain(host, root) {
  return Boolean(host && root && (host === root || host.endsWith(`.${root}`)));
}

function isTextual(mimeType = "") {
  return /json|text|javascript|xml|html|css|graphql|x-www-form-urlencoded/i.test(mimeType);
}
