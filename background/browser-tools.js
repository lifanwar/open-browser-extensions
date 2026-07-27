import { deleteAllCurrentPageCookies, deleteCurrentPageCookie, importCurrentPageCookies, listCurrentPageCookies, setCurrentPageCookie } from "./cookie-tools.js";
import { clearNetwork, getNetwork, startNetwork, stopNetwork } from "./network-debugger.js";
import { executeWebSearch, isWebSearchTool } from "./tools/search/search-tool.js";

export async function getInitialTargetTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((item) => isNormalWebUrl(item.url));
  if (!tab?.id) throw new Error("Tidak ada tab web aktif yang dapat dikontrol.");
  return tab;
}

export async function executeTool(name, args, context) {
  if (isWebSearchTool(name)) return executeWebSearch(args, context);
  if (name === "list_tabs") return listTabs();
  if (name === "switch_tab") return switchTab(args, context);

  const tabId = context.targetTabId;
  if (!tabId) throw new Error("Target tab belum tersedia.");

  switch (name) {
    case "read_page": {
      if (context.settings.autoStartNetwork) {
        try {
          await startNetwork(tabId, { captureBodies: context.settings.captureResponseBodies });
        } catch (error) {
          context.emit("status", `Network capture tidak aktif: ${error.message}`);
        }
      }
      return sendToPage(tabId, { type: "READ_PAGE" });
    }
    case "click":
      return sendToPage(tabId, { type: "CLICK", ref: args.ref });
    case "fill":
      return sendToPage(tabId, { type: "FILL", ref: args.ref, text: args.text });
    case "select_option":
      return sendToPage(tabId, { type: "SELECT", ref: args.ref, value: args.value });
    case "press_key":
      return sendToPage(tabId, { type: "PRESS_KEY", ref: args.ref, key: args.key });
    case "scroll_page":
      return sendToPage(tabId, { type: "SCROLL", ...args });
    case "wait":
      await delay(Math.max(100, Math.min(10_000, Number(args.milliseconds || 500))));
      return { waited: true, milliseconds: Number(args.milliseconds || 500) };
    case "navigate":
      return navigate(tabId, args.url);
    case "network_start":
      return startNetwork(tabId, { captureBodies: context.settings.captureResponseBodies });
    case "network_get":
      return getNetwork(tabId, args, context.settings);
    case "network_clear":
      return clearNetwork(tabId);
    case "network_stop":
      return stopNetwork(tabId);
    case "cookies_list":
      return listCurrentPageCookies(tabId, args);
    case "cookies_set":
      return setCurrentPageCookie(tabId, args, context.settings);
    case "cookies_import":
      return importCurrentPageCookies(tabId, args, context.settings);
    case "cookies_delete":
      return deleteCurrentPageCookie(tabId, args, context.settings);
    case "cookies_delete_all":
      return deleteAllCurrentPageCookies(tabId, args, context.settings);
    default:
      throw new Error(`Tool tidak dikenal: ${name}`);
  }
}

async function sendToPage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (String(error?.message || error).includes("Receiving end does not exist")) {
      throw new Error("Content script belum tersedia pada halaman ini. Reload halaman target lalu coba lagi.");
    }
    throw error;
  }
}

async function navigate(tabId, rawUrl) {
  const url = normalizeHttpUrl(rawUrl);
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId, 20_000);
  return { navigated: true, url };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter((tab) => tab.id && isNormalWebUrl(tab.url))
    .map((tab) => ({ tab_id: tab.id, active: tab.active, title: tab.title, url: tab.url }));
}

async function switchTab(args, context) {
  const tabId = Number(args.tab_id);
  const tab = await chrome.tabs.get(tabId);
  if (!isNormalWebUrl(tab.url)) throw new Error("Tab tersebut bukan halaman http/https yang dapat dikontrol.");
  context.targetTabId = tabId;
  await chrome.tabs.update(tabId, { active: true });
  return { switched: true, tab_id: tabId, title: tab.title, url: tab.url };
}

function normalizeHttpUrl(value) {
  let input = String(value || "").trim();
  if (!/^[a-z]+:\/\//i.test(input)) input = `https://${input}`;
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Hanya URL http/https yang didukung.");
  return url.href;
}

function isNormalWebUrl(url = "") {
  return /^https?:\/\//i.test(url);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
