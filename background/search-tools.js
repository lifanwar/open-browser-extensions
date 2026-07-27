const SEARCH_TIMEOUT_MS = 25_000;
const MAX_RESULT_CONTENT = 24_000;
const MAX_RESULTS = 10;

export async function executeWebSearch(args = {}, context = {}) {
  const settings = context.settings || {};
  if (!settings.enableSearchTool) {
    throw new Error("Web search tool is disabled in Settings.");
  }

  const endpoint = normalizeSearchEndpoint(settings.searchBaseUrl);
  const apiKey = String(settings.searchApiKey || "").trim();
  if (!endpoint || !apiKey) {
    throw new Error("Search connection is incomplete. Configure the Search API endpoint and API key in Settings.");
  }

  const task = normalizeSearchTask(args);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Search request timed out.")), SEARCH_TIMEOUT_MS);
  const parentSignal = context.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error("Search request cancelled."));

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ task }),
      signal: controller.signal
    });

    const rawText = await response.text();
    const payload = parseResponsePayload(rawText);

    if (!response.ok) {
      const detail = extractErrorMessage(payload) || rawText || response.statusText;
      throw new Error(`Search API returned HTTP ${response.status}${detail ? `: ${truncate(detail, 500)}` : ""}`);
    }
    if (payload && typeof payload === "object" && payload.success === false) {
      throw new Error(extractErrorMessage(payload) || "Search API reported an unsuccessful response.");
    }

    const results = normalizeSearchResults(payload, task);
    const status = results.length ? "success" : "no_results";
    return {
      ok: true,
      mode: task.mode,
      status,
      query: task.mode === "SEARCH" ? task.query : undefined,
      url: task.mode === "EXTRACT" ? task.url : undefined,
      count: results.length,
      results,
      message: results.length
        ? `${results.length} search source${results.length === 1 ? "" : "s"} found.`
        : task.mode === "SEARCH"
          ? `No search results found for “${task.query}”.`
          : "The Search API returned no extractable content for this URL."
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const cancelled = parentSignal?.aborted;
      throw new Error(cancelled ? "Search request cancelled." : "Search API request timed out after 25 seconds.");
    }
    const message = error?.message || String(error);
    if (/^Search API|^Search connection|^Web search tool|^No search|^Invalid|^SEARCH|^EXTRACT/.test(message)) {
      throw error;
    }
    throw new Error(`Search API request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
  }
}

export function normalizeSearchEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Search API endpoint is not a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Search API endpoint must use http or https.");
  }
  return url.href;
}

export function normalizeSearchTask(args = {}) {
  const rawTask = args?.task && typeof args.task === "object" ? args.task : args;
  const mode = String(rawTask?.mode || "SEARCH").trim().toUpperCase();

  if (mode === "SEARCH") {
    const query = String(rawTask?.query || "").trim();
    if (!query) throw new Error("SEARCH mode requires a non-empty query.");
    return {
      mode,
      query: truncate(query, 2_000),
      num_results: clampInteger(rawTask?.num_results, 1, MAX_RESULTS, 5)
    };
  }

  if (mode === "EXTRACT") {
    const url = normalizePublicHttpUrl(rawTask?.url);
    const objective = String(rawTask?.objective || "").trim();
    return {
      mode,
      url,
      ...(objective ? { objective: truncate(objective, 2_000) } : {})
    };
  }

  throw new Error(`Invalid search mode: ${mode || "(empty)"}. Use SEARCH or EXTRACT.`);
}

export function normalizeSearchResults(payload, task) {
  const normalizedPayload = unwrapJsonStrings(payload);
  const candidates = extractResultCandidates(normalizedPayload, task.mode);
  const seen = new Set();
  const results = [];

  for (const candidate of candidates) {
    const result = normalizeResult(candidate, task);
    if (!result) continue;
    const identity = `${result.url}\n${result.title}\n${result.snippet}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    results.push(result);
    if (results.length >= (task.mode === "SEARCH" ? task.num_results : MAX_RESULTS)) break;
  }
  return results;
}

function parseResponsePayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Search API returned invalid JSON: ${truncate(text, 300)}`);
  }
}

function unwrapJsonStrings(value, depth = 0) {
  if (depth > 4) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try { return unwrapJsonStrings(JSON.parse(text), depth + 1); } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => unwrapJsonStrings(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapJsonStrings(item, depth + 1)]));
  }
  return value;
}

function extractResultCandidates(payload, mode) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const arrays = [
    payload?.data?.results,
    payload?.data?.data?.results,
    payload?.results,
    payload?.organic,
    payload?.items,
    payload?.web?.results,
    Array.isArray(payload?.data) ? payload.data : null
  ].filter(Array.isArray);
  if (arrays.length) return arrays[0];

  if (mode === "EXTRACT") {
    const single = payload?.data?.result || payload?.result || payload?.data || payload;
    return single && typeof single === "object" ? [single] : [];
  }
  return [];
}

function normalizeResult(candidate, task) {
  if (candidate == null) return null;
  if (typeof candidate === "string") {
    const text = truncate(candidate.trim(), MAX_RESULT_CONTENT);
    if (!text) return null;
    return task.mode === "EXTRACT"
      ? { title: task.url, url: task.url, snippet: truncate(text, 600), content: text }
      : null;
  }
  if (typeof candidate !== "object") return null;

  const rawUrl = candidate.url || candidate.link || candidate.href || (task.mode === "EXTRACT" ? task.url : "");
  const url = tryNormalizePublicHttpUrl(rawUrl);
  if (!url) return null;

  const title = truncate(String(candidate.title || candidate.name || candidate.page_title || url).trim(), 500);
  const rawSnippet = candidate.snippet || candidate.description || candidate.summary || candidate.text || candidate.content || candidate.body || "";
  const rawContent = candidate.content || candidate.markdown || candidate.text || candidate.body || candidate.snippet || "";
  const snippet = truncate(cleanText(rawSnippet), 1_200);
  const content = truncate(cleanText(rawContent), MAX_RESULT_CONTENT);

  return {
    title: title || url,
    url,
    ...(snippet ? { snippet } : {}),
    ...(content && content !== snippet ? { content } : {}),
    ...(Number.isFinite(Number(candidate.score)) ? { score: Number(candidate.score) } : {})
  };
}

function normalizePublicHttpUrl(value) {
  const url = tryNormalizePublicHttpUrl(value);
  if (!url) throw new Error("EXTRACT mode requires a valid http or https URL.");
  return url;
}

function tryNormalizePublicHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function extractErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  const value = payload.error?.message || payload.error || payload.message || payload.detail || payload.data?.message;
  return typeof value === "string" ? value : value ? JSON.stringify(value) : "";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}
