import {
  CREDENTIAL_FIELDS,
  CREDENTIAL_PLACEHOLDER,
  ENCRYPTED_CREDENTIALS_KEY,
  clearCredentialFields,
  createEncryptedCredentialStore,
  decryptCredential,
  encryptCredential,
  getCredentialKey,
  hasEncryptedCredentials,
  normalizeEncryptedCredentialStore
} from "./credential-store.js";

export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: "https://api.openai.com/v1",
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
  searchModel: "search-combo",
  fetchModel: "fetch-combo",
  searchDefaultType: "web",
  searchMaxResults: 5,
  fetchFormat: "markdown",
  systemPrompt: ""
});

export async function loadSettings(options = {}) {
  const state = await readStoredState(options);
  return createPublicSettings(state.settings, state.encryptedCredentials);
}

export async function loadRunSettings(options = {}) {
  const state = await readStoredState(options);
  const settings = sanitizeSettings(state.settings);
  const encrypted = state.encryptedCredentials;
  if (!hasEncryptedCredentials(encrypted)) return { ...settings, apiKey: "", searchApiKey: "", fetchApiKey: "" };

  const key = await getCredentialKey({ ...credentialOptions(options), create: false });
  if (!key) throw new Error("Stored credential encryption key is missing. Re-enter all configured API keys.");

  try {
    for (const field of CREDENTIAL_FIELDS) {
      settings[field] = encrypted.credentials[field]
        ? await decryptCredential(encrypted.credentials[field], field, key, credentialOptions(options).cryptoImpl)
        : "";
    }
    return settings;
  } catch (error) {
    clearCredentialFields(settings);
    throw error;
  }
}

export async function saveSettings(settings, options = {}) {
  const state = await readStoredState(options);
  const nextSettings = sanitizeSettings(settings);
  let encrypted = createEncryptedCredentialStore(state.encryptedCredentials.credentials);
  const existingCount = CREDENTIAL_FIELDS.filter((field) => encrypted.credentials[field]).length;
  const changed = [];
  let preservesExisting = false;

  for (const field of CREDENTIAL_FIELDS) {
    const input = settings?.[field];
    if (input === undefined || input === CREDENTIAL_PLACEHOLDER) {
      if (encrypted.credentials[field]) preservesExisting = true;
      continue;
    }
    const value = String(input || "").trim();
    if (!value) delete encrypted.credentials[field];
    else changed.push([field, value]);
  }

  let key = null;
  if (existingCount) key = await getCredentialKey({ ...credentialOptions(options), create: false });
  if (!key && existingCount && preservesExisting) {
    throw new Error("Stored credential encryption key is missing. Re-enter all configured API keys before saving.");
  }
  if (!key && existingCount) encrypted = createEncryptedCredentialStore();
  if (changed.length) key ||= await getCredentialKey({ ...credentialOptions(options), create: true });

  for (const [field, value] of changed) {
    encrypted.credentials[field] = await encryptCredential(value, field, key, credentialOptions(options).cryptoImpl);
  }

  await storage(options).set({
    settings: nextSettings,
    [ENCRYPTED_CREDENTIALS_KEY]: encrypted
  });
  return createPublicSettings(nextSettings, encrypted);
}

export async function exportSettings(options = {}) {
  const state = await readStoredState(options);
  return {
    version: 1,
    settings: sanitizeSettings(state.settings),
    encryptedCredentials: createEncryptedCredentialStore(state.encryptedCredentials.credentials)
  };
}

export async function importSettings(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1 || !snapshot.settings || typeof snapshot.settings !== "object") {
    throw new Error("Settings import is invalid.");
  }

  const legacyPlaintext = CREDENTIAL_FIELDS.some((field) => String(snapshot.settings[field] || "").trim());
  const importedEncrypted = snapshot.encryptedCredentials
    ? normalizeEncryptedCredentialStore(snapshot.encryptedCredentials)
    : createEncryptedCredentialStore();

  if (legacyPlaintext && hasEncryptedCredentials(importedEncrypted)) {
    throw new Error("Settings import contains both plaintext and encrypted credentials.");
  }
  if (legacyPlaintext) return saveSettings(snapshot.settings, options);

  if (hasEncryptedCredentials(importedEncrypted)) {
    const key = await getCredentialKey({ ...credentialOptions(options), create: false });
    if (!key) throw new Error("The credential encryption key required by this import is missing.");
    const verified = {};
    try {
      for (const field of CREDENTIAL_FIELDS) {
        if (importedEncrypted.credentials[field]) {
          verified[field] = await decryptCredential(
            importedEncrypted.credentials[field],
            field,
            key,
            credentialOptions(options).cryptoImpl
          );
        }
      }
    } finally {
      clearCredentialFields(verified);
    }
  }

  const importedSettings = sanitizeSettings(snapshot.settings);
  await storage(options).set({
    settings: importedSettings,
    [ENCRYPTED_CREDENTIALS_KEY]: importedEncrypted
  });
  return createPublicSettings(importedSettings, importedEncrypted);
}

async function readStoredState(options) {
  const stored = await storage(options).get(["settings", ENCRYPTED_CREDENTIALS_KEY]);
  const rawSettings = stored.settings && typeof stored.settings === "object" ? stored.settings : {};
  let encrypted = normalizeEncryptedCredentialStore(stored[ENCRYPTED_CREDENTIALS_KEY]);
  const legacy = [];
  let hasLegacyFields = false;

  for (const field of CREDENTIAL_FIELDS) {
    if (!(field in rawSettings)) continue;
    hasLegacyFields = true;
    const value = String(rawSettings[field] || "").trim();
    if (value) legacy.push([field, value]);
  }

  const cleanSettings = stripCredentialFields(rawSettings);
  if (!hasLegacyFields) {
    return { settings: cleanSettings, encryptedCredentials: encrypted };
  }

  if (legacy.length) {
    let key = null;
    if (hasEncryptedCredentials(encrypted)) {
      key = await getCredentialKey({ ...credentialOptions(options), create: false });
      if (!key) throw new Error("Stored credential encryption key is missing. Re-enter all configured API keys.");
    }
    key ||= await getCredentialKey({ ...credentialOptions(options), create: true });
    for (const [field, value] of legacy) {
      encrypted.credentials[field] = await encryptCredential(value, field, key, credentialOptions(options).cryptoImpl);
    }
  }

  await storage(options).set({
    settings: cleanSettings,
    [ENCRYPTED_CREDENTIALS_KEY]: encrypted
  });
  return { settings: cleanSettings, encryptedCredentials: encrypted };
}

function createPublicSettings(settings, encrypted) {
  const result = sanitizeSettings(settings);
  for (const field of CREDENTIAL_FIELDS) {
    result[field] = encrypted?.credentials?.[field] ? CREDENTIAL_PLACEHOLDER : "";
  }
  return result;
}

function sanitizeSettings(settings = {}) {
  const source = { ...DEFAULT_SETTINGS, ...stripCredentialFields(settings) };
  const appearance = ["system", "light", "dark"].includes(source.appearance)
    ? source.appearance
    : DEFAULT_SETTINGS.appearance;
  const searchConnectionMode = source.searchConnectionMode === "9router" ? "9router" : "direct";
  const searchDefaultType = source.searchDefaultType === "news" ? "news" : "web";
  const fetchFormat = ["markdown", "text", "html"].includes(source.fetchFormat)
    ? source.fetchFormat
    : DEFAULT_SETTINGS.fetchFormat;
  return {
    ...source,
    baseUrl: String(source.baseUrl || "").trim(),
    model: String(source.model || "").trim(),
    searchConnectionMode,
    searchBaseUrl: String(source.searchBaseUrl || "").trim(),
    searchEndpoint: String(source.searchEndpoint || "").trim(),
    fetchEndpoint: String(source.fetchEndpoint || "").trim(),
    searchModel: String(source.searchModel || "").trim(),
    fetchModel: String(source.fetchModel || "").trim(),
    searchDefaultType,
    searchMaxResults: Math.round(clampNumber(source.searchMaxResults, 1, 10, DEFAULT_SETTINGS.searchMaxResults)),
    fetchFormat,
    systemPrompt: String(source.systemPrompt || ""),
    appearance,
    temperature: clampNumber(source.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxToolSteps: sanitizeMaxToolSteps(source.maxToolSteps),
    streamResponses: source.streamResponses !== false,
    autoStartNetwork: source.autoStartNetwork !== false,
    revealSensitiveOnCurrentHost: Boolean(source.revealSensitiveOnCurrentHost),
    captureResponseBodies: source.captureResponseBodies !== false,
    allowCookieWrites: Boolean(source.allowCookieWrites),
    enableSearchTool: Boolean(source.enableSearchTool)
  };
}

function stripCredentialFields(settings) {
  const clean = { ...(settings || {}) };
  for (const field of CREDENTIAL_FIELDS) delete clean[field];
  return clean;
}

function storage(options) {
  return options.storage || chrome.storage.local;
}

function credentialOptions(options) {
  return options.credentialOptions || {};
}

function sanitizeMaxToolSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(clampNumber(n, 1, 50, DEFAULT_SETTINGS.maxToolSteps));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
