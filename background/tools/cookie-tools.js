
export async function listCurrentPageCookies(tabId, args = {}) {
  const tab = await getWebTab(tabId);
  const url = new URL(tab.url);
  const cookies = await chrome.cookies.getAll({ url: tab.url });
  const includeValues = args.include_values !== false;

  const items = cookies.map((cookie) => {
    return {
      name: cookie.name,
      value: includeValues ? cookie.value : "[REDACTED]",
      value_redacted: !includeValues,
      domain: cookie.domain,
      host_only: cookie.hostOnly,
      path: cookie.path,
      secure: cookie.secure,
      http_only: cookie.httpOnly,
      same_site: cookie.sameSite,
      session: cookie.session,
      expiration_date: cookie.expirationDate ?? null,
      store_id: cookie.storeId,
      partition_key: cookie.partitionKey || null
    };
  });

  const exportable = items.map(({ value_redacted, host_only, store_id, partition_key, ...cookie }) => cookie);

  return {
    page_host: url.hostname,
    count: items.length,
    cookies: items,
    export_json: JSON.stringify(exportable, null, 2),
    note: "All cookies are shown as-is, including HttpOnly and auth cookies."
  };
}

export async function setCurrentPageCookie(tabId, args, settings) {
  assertWritesEnabled(settings);
  const tab = await getWebTab(tabId);
  const normalized = normalizeImportCookie(args.cookie || args, tab.url);
  const result = await chrome.cookies.set(normalized);
  if (!result) throw new Error("Chrome did not return the cookie after saving.");
  return { saved: true, cookie: safeCookieResult(result) };
}

export async function importCurrentPageCookies(tabId, args, settings) {
  assertWritesEnabled(settings);
  const tab = await getWebTab(tabId);
  const input = parseCookieInput(args.cookies_json ?? args.cookies ?? args.json);
  if (!Array.isArray(input) || !input.length) throw new Error("Cookie list is empty.");

  const results = [];
  for (const item of input) {
    try {
      const normalized = normalizeImportCookie(item, tab.url);
      const saved = await chrome.cookies.set(normalized);
      results.push({ name: normalized.name, ok: Boolean(saved) });
    } catch (error) {
      results.push({ name: String(item?.name || ""), ok: false, error: error.message });
    }
  }
  return {
    imported: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results
  };
}

export async function deleteCurrentPageCookie(tabId, args, settings) {
  assertWritesEnabled(settings);
  const tab = await getWebTab(tabId);
  const cookies = await chrome.cookies.getAll({ url: tab.url, name: String(args.name || "") });
  const pathFilter = args.path == null ? null : String(args.path);
  const domainFilter = args.domain == null ? null : normalizeDomain(args.domain);
  const matches = cookies.filter((cookie) => {
    if (pathFilter != null && cookie.path !== pathFilter) return false;
    if (domainFilter != null && normalizeDomain(cookie.domain) !== domainFilter) return false;
    return true;
  });
  const removed = [];
  for (const cookie of matches) {
    const result = await chrome.cookies.remove(removeDetails(cookie));
    if (result) removed.push({ name: cookie.name, domain: cookie.domain, path: cookie.path });
  }
  return { removed_count: removed.length, removed };
}

export async function deleteAllCurrentPageCookies(tabId, args, settings) {
  assertWritesEnabled(settings);
  const tab = await getWebTab(tabId);
  const cookies = await chrome.cookies.getAll({ url: tab.url });
  const removed = [];
  for (const cookie of cookies) {
    const result = await chrome.cookies.remove(removeDetails(cookie));
    if (result) removed.push({ name: cookie.name, domain: cookie.domain, path: cookie.path });
  }
  return { removed_count: removed.length, removed };
}

function normalizeImportCookie(raw, pageUrl) {
  if (!raw || typeof raw !== "object") throw new Error("Cookie must be an object.");
  const page = new URL(pageUrl);
  const name = String(raw.name || "").trim();
  const value = String(raw.value ?? "");
  if (!name) throw new Error("Cookie name is required.");
  const requestedDomain = raw.domain ? normalizeDomain(raw.domain) : "";

  const secure = raw.secure === true || page.protocol === "https:";
  const path = normalizePath(raw.path);
  const details = {
    url: `${secure ? "https:" : page.protocol}//${page.hostname}${path}`,
    name,
    value,
    path,
    secure,
    sameSite: normalizeSameSite(raw.sameSite ?? raw.same_site)
  };

  if (requestedDomain && !name.startsWith("__Host-")) details.domain = requestedDomain;
  const expirationDate = Number(raw.expirationDate ?? raw.expiration_date ?? raw.expires);
  if (Number.isFinite(expirationDate) && expirationDate > Date.now() / 1000) details.expirationDate = expirationDate;

  if (name.startsWith("__Host-")) {
    details.path = "/";
    details.secure = true;
    delete details.domain;
  }
  if (name.startsWith("__Secure-")) details.secure = true;
  return details;
}

function parseCookieInput(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error("Use a cookie array or JSON string.");
  try { return JSON.parse(value); } catch { throw new Error("Invalid cookie JSON."); }
}

function removeDetails(cookie) {
  const protocol = cookie.secure ? "https:" : "http:";
  const host = normalizeDomain(cookie.domain);
  const details = {
    url: `${protocol}//${host}${normalizePath(cookie.path)}`,
    name: cookie.name,
    storeId: cookie.storeId
  };
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  return details;
}

function safeCookieResult(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    http_only: cookie.httpOnly,
    same_site: cookie.sameSite,
    session: cookie.session,
    expiration_date: cookie.expirationDate ?? null
  };
}

async function getWebTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//i.test(tab.url || "")) throw new Error("Cookie tools are only available on http/https pages.");
  return tab;
}

function assertWritesEnabled(settings) {
  if (!settings?.allowCookieWrites) {
    throw new Error("Cookie write tools are not enabled. Open Settings and enable Allow cookie paste/delete.");
  }
}

function normalizeDomain(value) {
  return String(value || "").trim().replace(/^\./, "").toLowerCase();
}

function normalizePath(value) {
  const path = String(value || "/").trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeSameSite(value) {
  const normalized = String(value || "unspecified").toLowerCase().replace(/_/g, "-");
  if (["lax", "strict", "unspecified"].includes(normalized)) return normalized;
  if (["none", "no-restriction", "no_restriction"].includes(normalized)) return "no_restriction";
  return "unspecified";
}
