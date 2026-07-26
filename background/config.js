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
  const clean = {
    ...DEFAULT_SETTINGS,
    ...settings,
    appearance,
    temperature: clampNumber(settings.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxToolSteps: Math.round(clampNumber(settings.maxToolSteps, 1, 50, DEFAULT_SETTINGS.maxToolSteps)),
    streamResponses: settings.streamResponses !== false,
    autoStartNetwork: Boolean(settings.autoStartNetwork),
    revealSensitiveOnCurrentHost: Boolean(settings.revealSensitiveOnCurrentHost),
    captureResponseBodies: Boolean(settings.captureResponseBodies),
    allowCookieWrites: Boolean(settings.allowCookieWrites)
  };
  await chrome.storage.local.set({ settings: clean });
  return clean;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
