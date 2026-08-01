import { runAgent } from "./agent.js";
import { exportSettings, importSettings, loadRunSettings, loadSettings, saveSettings } from "./config.js";
import {
  CREDENTIAL_FIELDS,
  ENCRYPTED_CREDENTIALS_KEY,
  clearCredentialFields,
  credentialValues,
  decryptCredential,
  getCredentialKey,
  normalizeEncryptedCredentialStore,
  redactSensitiveText
} from "./credential-store.js";

const activeRuns = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_SETTINGS":
      return loadSettings();
    case "SAVE_SETTINGS":
      return saveSettings(message.settings || {});
    case "EXPORT_SETTINGS":
      return exportSettings();
    case "IMPORT_SETTINGS":
      return importSettings(message.snapshot || {});
    case "RUN_AGENT":
      return startRun(message);
    case "QUEUE_AGENT_MESSAGE":
      return queueRunMessage(message.runId, message.content);
    case "REVEAL_CREDENTIAL":
      assertCredentialRevealSender(sender);
      return revealCredential(message.field);
    case "CANCEL_AGENT":
      return cancelRun(message.runId);
    default:
      throw new Error(`Unknown message: ${message?.type}`);
  }
}

async function startRun(message) {
  const runId = String(message.runId || crypto.randomUUID());
  if (activeRuns.has(runId)) throw new Error("Run ID is already in use.");

  const run = createRunState();
  activeRuns.set(runId, run);
  let emitChain = Promise.resolve();
  const emit = (event, payload) => {
    emitChain = emitChain
      .then(() => chrome.runtime.sendMessage({ type: "AGENT_EVENT", runId, event, payload }))
      .catch(() => {});
  };

  try {
    const loadedSettings = await loadRunSettings();
    if (run.controller.signal.aborted) {
      clearCredentialFields(loadedSettings);
      throw new DOMException("Aborted", "AbortError");
    }
    run.settings = { ...loadedSettings, ...(message.settings || {}) };
    if (!run.settings.baseUrl) throw new Error("Base URL is not set.");
    if (!run.settings.model) throw new Error("Model is not set.");

    emit("status", "Agent started.");
    const result = await runAgent({
      runId,
      history: message.history || [],
      contextState: message.contextState || null,
      settings: run.settings,
      signal: run.controller.signal,
      emit,
      takeQueuedMessages: (options) => takeQueuedMessages(run, options)
    });
    emit("done", result);
    await emitChain;
    return result;
  } catch (error) {
    const messageText = redactSensitiveText(error?.message || String(error), credentialValues(run.settings));
    if (run.controller.signal.aborted) {
      emit("cancelled", "Agent stopped.");
      await emitChain;
      throw new Error("Agent stopped.");
    }
    emit("error", messageText);
    await emitChain;
    throw new Error(messageText);
  } finally {
    disposeRunState(run);
    if (activeRuns.get(runId) === run) activeRuns.delete(runId);
  }
}

function queueRunMessage(runId, rawContent) {
  const id = String(runId || "");
  const run = activeRuns.get(id);
  if (!run || !run.acceptingMessages || run.controller.signal.aborted) {
    return { accepted: false, runId: id, retryAsNewRun: true };
  }

  const queueLength = enqueueRunMessage(run, rawContent);
  return { accepted: true, runId: id, queueLength };
}

function cancelRun(runId) {
  const run = activeRuns.get(String(runId));
  if (!run) return { cancelled: false };
  cancelRunState(run);
  return { cancelled: true };
}

function assertCredentialRevealSender(sender) {
  const sidepanelUrl = chrome.runtime.getURL("sidepanel/");
  if (sender?.id !== chrome.runtime.id || sender?.tab || !String(sender?.url || "").startsWith(sidepanelUrl)) {
    throw new Error("Credential reveal is only allowed from the extension side panel.");
  }
}

async function revealCredential(field) {
  if (!CREDENTIAL_FIELDS.includes(field)) throw new Error("Unknown credential field.");
  const stored = await chrome.storage.local.get([ENCRYPTED_CREDENTIALS_KEY]);
  const encrypted = normalizeEncryptedCredentialStore(stored[ENCRYPTED_CREDENTIALS_KEY]);
  if (!encrypted.credentials[field]) return "";
  const key = await getCredentialKey({ create: false });
  if (!key) throw new Error("Credential encryption key is missing.");
  return decryptCredential(encrypted.credentials[field], field, key);
}

export function createRunState() {
  return {
    controller: new AbortController(),
    queue: [],
    acceptingMessages: true,
    settings: null
  };
}

export function enqueueRunMessage(run, rawContent) {
  const content = String(rawContent || "").trim();
  if (!content) throw new Error("Queued instruction must not be empty.");
  if (!run || !run.acceptingMessages || run.controller.signal.aborted) {
    throw new Error("Run is no longer active. Instruction was not queued.");
  }

  run.queue.push(content);
  return run.queue.length;
}

export function takeQueuedMessages(run, { closeIfEmpty = false } = {}) {
  if (!run || run.controller.signal.aborted) return [];
  if (run.queue.length) return run.queue.splice(0, run.queue.length);
  if (closeIfEmpty) run.acceptingMessages = false;
  return [];
}

export function cancelRunState(run) {
  if (!run) return false;
  run.acceptingMessages = false;
  run.queue.length = 0;
  run.controller.abort();
  clearRunCredentials(run);
  return true;
}

export function disposeRunState(run) {
  if (!run) return;
  run.acceptingMessages = false;
  run.queue.length = 0;
  clearRunCredentials(run);
}

function clearRunCredentials(run) {
  clearCredentialFields(run.settings);
  run.settings = null;
}
