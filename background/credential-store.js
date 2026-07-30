export const CREDENTIAL_FIELDS = Object.freeze(["apiKey", "searchApiKey", "fetchApiKey"]);
export const CREDENTIAL_PLACEHOLDER = "••••••••";
export const ENCRYPTED_CREDENTIALS_KEY = "encryptedCredentials";

const DATABASE_NAME = "open-browser-agent-secure-storage";
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = "keys";
const ENCRYPTION_KEY_ID = "settings-aes-gcm-v1";
const RECORD_VERSION = 1;
const STORE_VERSION = 1;
const IV_BYTES = 12;
const REDACTED = "[REDACTED API KEY]";

export async function getCredentialKey({
  create = false,
  cryptoImpl = globalThis.crypto,
  openKeyStore = () => openIndexedDbKeyStore(globalThis.indexedDB)
} = {}) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto API is unavailable.");
  const store = await openKeyStore();
  try {
    const existing = await store.get(ENCRYPTION_KEY_ID);
    if (existing) return validateEncryptionKey(existing);
    if (!create) return null;

    const generated = await cryptoImpl.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    try {
      await store.add(ENCRYPTION_KEY_ID, generated);
      return generated;
    } catch (error) {
      if (error?.name !== "ConstraintError") throw error;
      const raced = await store.get(ENCRYPTION_KEY_ID);
      if (!raced) throw error;
      return validateEncryptionKey(raced);
    }
  } finally {
    store.close?.();
  }
}

export async function encryptCredential(value, field, key, cryptoImpl = globalThis.crypto) {
  validateCredentialField(field);
  validateEncryptionKey(key);
  const iv = cryptoImpl.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(String(value));
  try {
    const ciphertext = await cryptoImpl.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(field), tagLength: 128 },
      key,
      encoded
    );
    return {
      version: RECORD_VERSION,
      algorithm: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
  } finally {
    encoded.fill(0);
  }
}

export async function decryptCredential(record, field, key, cryptoImpl = globalThis.crypto) {
  validateCredentialField(field);
  validateEncryptionKey(key);
  validateEncryptedRecord(record);
  try {
    const plaintext = new Uint8Array(await cryptoImpl.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(record.iv),
        additionalData: additionalData(field),
        tagLength: 128
      },
      key,
      base64ToBytes(record.ciphertext)
    ));
    try {
      return new TextDecoder().decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new Error("Stored API credentials cannot be decrypted or are corrupted.");
  }
}

export function createEncryptedCredentialStore(credentials = {}) {
  const clean = {};
  for (const field of CREDENTIAL_FIELDS) {
    if (credentials[field]) clean[field] = credentials[field];
  }
  return { version: STORE_VERSION, credentials: clean };
}

export function normalizeEncryptedCredentialStore(value) {
  if (value == null) return createEncryptedCredentialStore();
  if (
    typeof value !== "object" || value.version !== STORE_VERSION ||
    !value.credentials || typeof value.credentials !== "object" || Array.isArray(value.credentials)
  ) {
    throw new Error("Stored API credentials cannot be decrypted or are corrupted.");
  }
  const credentials = {};
  for (const field of CREDENTIAL_FIELDS) {
    if (value.credentials[field]) credentials[field] = value.credentials[field];
  }
  return createEncryptedCredentialStore(credentials);
}

export function hasEncryptedCredentials(store) {
  return CREDENTIAL_FIELDS.some((field) => Boolean(store?.credentials?.[field]));
}

export function clearCredentialFields(settings) {
  if (!settings || typeof settings !== "object") return;
  for (const field of CREDENTIAL_FIELDS) settings[field] = "";
}

export function credentialValues(settings) {
  return CREDENTIAL_FIELDS
    .map((field) => String(settings?.[field] || ""))
    .filter((value) => value && value !== CREDENTIAL_PLACEHOLDER);
}

export function redactSensitiveText(value, secrets) {
  let text = String(value ?? "");
  for (const secret of normalizeSecrets(secrets)) text = text.split(secret).join(REDACTED);
  return text;
}

export function createSensitiveStreamRedactor(secrets) {
  const values = normalizeSecrets(secrets);
  let pending = "";

  const consume = (final) => {
    if (!values.length) {
      const output = pending;
      pending = "";
      return output;
    }

    let output = "";
    while (pending) {
      let matchIndex = -1;
      let matchSecret = "";
      for (const secret of values) {
        const index = pending.indexOf(secret);
        if (index >= 0 && (matchIndex < 0 || index < matchIndex || (index === matchIndex && secret.length > matchSecret.length))) {
          matchIndex = index;
          matchSecret = secret;
        }
      }
      if (matchIndex < 0) break;
      output += pending.slice(0, matchIndex) + REDACTED;
      pending = pending.slice(matchIndex + matchSecret.length);
    }

    if (final) {
      output += pending;
      pending = "";
      return output;
    }

    let hold = 0;
    const maxHold = Math.min(pending.length, Math.max(...values.map((value) => value.length)) - 1);
    for (let length = maxHold; length > 0; length -= 1) {
      const suffix = pending.slice(-length);
      if (values.some((secret) => secret.startsWith(suffix))) {
        hold = length;
        break;
      }
    }
    output += pending.slice(0, pending.length - hold);
    pending = hold ? pending.slice(-hold) : "";
    return output;
  };

  return {
    push(value) {
      pending += String(value || "");
      return consume(false);
    },
    flush() {
      return consume(true);
    }
  };
}

export function redactSensitiveValue(value, secrets, seen = new WeakSet()) {
  const normalizedSecrets = normalizeSecrets(secrets);
  if (!normalizedSecrets.length) return value;
  if (typeof value === "string") return redactSensitiveText(value, normalizedSecrets);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, normalizedSecrets, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSensitiveValue(item, normalizedSecrets, seen)])
  );
}

async function openIndexedDbKeyStore(indexedDBImpl) {
  if (!indexedDBImpl?.open) throw new Error("IndexedDB is unavailable.");
  const database = await new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open credential key storage."));
  });
  database.onversionchange = () => database.close();

  return {
    get(id) {
      return runRequest(database, "readonly", (store) => store.get(id));
    },
    add(id, value) {
      return runRequest(database, "readwrite", (store) => store.add(value, id));
    },
    close() {
      database.close();
    }
  };
}

function runRequest(database, mode, createRequest) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OBJECT_STORE_NAME, mode);
    const request = createRequest(transaction.objectStore(OBJECT_STORE_NAME));
    let result = null;
    request.onsuccess = () => { result = request.result ?? null; };
    request.onerror = () => reject(request.error || transaction.error || new Error("Credential key storage operation failed."));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error("Credential key storage transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("Credential key storage operation failed."));
  });
}

function validateEncryptionKey(key) {
  if (
    !key || key.type !== "secret" || key.extractable !== false ||
    key.algorithm?.name !== "AES-GCM" || Number(key.algorithm?.length) !== 256 ||
    !key.usages?.includes?.("encrypt") || !key.usages?.includes?.("decrypt")
  ) {
    throw new Error("Stored credential encryption key is invalid.");
  }
  return key;
}

function validateEncryptedRecord(record) {
  if (
    !record || record.version !== RECORD_VERSION || record.algorithm !== "AES-GCM" ||
    typeof record.iv !== "string" || typeof record.ciphertext !== "string"
  ) {
    throw new Error("Stored API credentials cannot be decrypted or are corrupted.");
  }
}

function validateCredentialField(field) {
  if (!CREDENTIAL_FIELDS.includes(field)) throw new Error("Unknown credential field.");
}

function additionalData(field) {
  return new TextEncoder().encode(`open-browser-agent:${field}:v${RECORD_VERSION}`);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  try {
    const binary = atob(String(value));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Stored API credentials cannot be decrypted or are corrupted.");
  }
}

function normalizeSecrets(value) {
  const items = Array.isArray(value) ? value : credentialValues(value);
  return [...new Set(items.map((item) => String(item || "")).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}
