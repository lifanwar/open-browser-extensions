export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  temperature: 0.2,
  maxToolSteps: 20,
  streamResponses: true,
  appearance: "system",
  autoStartNetwork: true,
  revealSensitiveOnCurrentHost: false,
  captureResponseBodies: true,
  allowCookieWrites: false,
  enableSearchTool: false,
  searchConnectionMode: "direct",
  searchBaseUrl: "http://localhost:20128/v1",
  searchEndpoint: "",
  fetchEndpoint: "",
  searchApiKey: "",
  fetchApiKey: "",
  searchModel: "search-combo",
  fetchModel: "fetch-combo",
  searchDefaultType: "web",
  searchMaxResults: 5,
  fetchFormat: "markdown",
  systemPrompt: ""
});

export async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(settings) {
  const appearance = ["system", "light", "dark"].includes(settings.appearance)
    ? settings.appearance
    : DEFAULT_SETTINGS.appearance;
  const searchConnectionMode = settings.searchConnectionMode === "9router" ? "9router" : "direct";
  const searchDefaultType = settings.searchDefaultType === "news" ? "news" : "web";
  const fetchFormat = ["markdown", "text", "html"].includes(settings.fetchFormat)
    ? settings.fetchFormat
    : DEFAULT_SETTINGS.fetchFormat;
  const clean = {
    ...DEFAULT_SETTINGS,
    ...settings,
    baseUrl: String(settings.baseUrl || "").trim(),
    apiKey: String(settings.apiKey || "").trim(),
    model: String(settings.model || "").trim(),
    searchConnectionMode,
    searchBaseUrl: String(settings.searchBaseUrl || "").trim(),
    searchEndpoint: String(settings.searchEndpoint || "").trim(),
    fetchEndpoint: String(settings.fetchEndpoint || "").trim(),
    searchApiKey: String(settings.searchApiKey || "").trim(),
    fetchApiKey: String(settings.fetchApiKey || "").trim(),
    searchModel: String(settings.searchModel || "").trim(),
    fetchModel: String(settings.fetchModel || "").trim(),
    searchDefaultType,
    searchMaxResults: Math.round(clampNumber(settings.searchMaxResults, 1, 10, DEFAULT_SETTINGS.searchMaxResults)),
    fetchFormat,
    systemPrompt: String(settings.systemPrompt || ""),
    appearance,
    temperature: clampNumber(settings.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxToolSteps: sanitizeMaxToolSteps(settings.maxToolSteps),
    streamResponses: settings.streamResponses !== false,
    autoStartNetwork: Boolean(settings.autoStartNetwork),
    revealSensitiveOnCurrentHost: Boolean(settings.revealSensitiveOnCurrentHost),
    captureResponseBodies: Boolean(settings.captureResponseBodies),
    allowCookieWrites: Boolean(settings.allowCookieWrites),
    enableSearchTool: Boolean(settings.enableSearchTool)
  };
  await chrome.storage.local.set({ settings: clean });
  return clean;
}

function sanitizeMaxToolSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null; // null = unlimited
  return Math.round(clampNumber(n, 1, 50, DEFAULT_SETTINGS.maxToolSteps));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
