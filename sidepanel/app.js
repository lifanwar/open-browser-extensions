const chat = document.querySelector("#chat");
const conversationTitle = document.querySelector("#conversationTitle");
const headerSubtitle = document.querySelector("#headerSubtitle");
const activityShell = document.querySelector("#activityShell");
const activityToggle = document.querySelector("#activityToggle");
const activityIndicator = document.querySelector("#activityIndicator");
const activitySummary = document.querySelector("#activitySummary");
const toolActivity = document.querySelector("#toolActivity");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#sendButton");
const stopButton = document.querySelector("#stopButton");
const conversationsButton = document.querySelector("#conversationsButton");
const brandButton = document.querySelector("#brandButton");
const settingsButton = document.querySelector("#settingsButton");
const modelChip = document.querySelector("#modelChip");
const modelChipText = document.querySelector("#modelChipText");
const apiStatusDot = document.querySelector("#apiStatusDot");
const pageChip = document.querySelector("#pageChip");
const pageChipText = document.querySelector("#pageChipText");
const settingsDialog = document.querySelector("#settingsDialog");
const settingsForm = document.querySelector("#settingsForm");
const settingsBody = document.querySelector("#settingsBody");
const closeSettings = document.querySelector("#closeSettings");
const cancelSettings = document.querySelector("#cancelSettings");
const toggleApiKey = document.querySelector("#toggleApiKey");
const conversationDrawer = document.querySelector("#conversationDrawer");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const closeDrawerButton = document.querySelector("#closeDrawer");
const newConversationButton = document.querySelector("#newConversationButton");
const conversationList = document.querySelector("#conversationList");

const CONVERSATIONS_KEY = "agentConversations";
const ACTIVE_CONVERSATION_KEY = "activeConversationId";
const LEGACY_HISTORY_KEY = "chatHistory";
const MAX_CONVERSATIONS = 60;
const MAX_MESSAGES_PER_CONVERSATION = 100;

let conversations = [];
let activeConversationId = null;
let history = [];
let settings = null;
let currentRunId = null;
let activeTab = null;
let activityOpen = false;
let doneEventContent = null;
let liveDraft = null;
let liveNodes = null;

const suggestions = [
  { icon: "spark", label: "Read this page and summarize the important points" },
  { icon: "cursor", label: "Find the main form and explain what each field does" },
  { icon: "network", label: "Inspect the latest API requests from this page" }
];

const systemThemeQuery = matchMedia("(prefers-color-scheme: dark)");
systemThemeQuery.addEventListener("change", () => {
  if (settings?.appearance === "system") applyAppearance("system");
});

init().catch((error) => renderFatalError(error));

async function init() {
  settings = await sendMessage({ type: "GET_SETTINGS" });
  applyAppearance(settings.appearance);
  await loadConversations();
  await refreshActiveTab();
  fillSettingsForm();
  updateChrome();
  renderChat();
  renderConversationList();
  resizePrompt();
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitPrompt(promptInput.value);
});

promptInput.addEventListener("input", resizePrompt);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

stopButton.addEventListener("click", async () => {
  if (!currentRunId) return;
  activitySummary.textContent = "Stopping…";
  await sendMessage({ type: "CANCEL_AGENT", runId: currentRunId }).catch(() => {});
});

conversationsButton.addEventListener("click", openDrawer);
closeDrawerButton.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
newConversationButton.addEventListener("click", async () => {
  await startNewChat();
  closeDrawer();
});
brandButton.addEventListener("click", startNewChat);

settingsButton.addEventListener("click", openSettings);
modelChip.addEventListener("click", openSettings);
closeSettings.addEventListener("click", () => settingsDialog.close());
cancelSettings.addEventListener("click", () => settingsDialog.close());

toggleApiKey.addEventListener("click", () => {
  const input = document.querySelector("#apiKey");
  input.type = input.type === "password" ? "text" : "password";
  toggleApiKey.setAttribute("aria-label", input.type === "password" ? "Show API key" : "Hide API key");
});

pageChip.addEventListener("click", refreshActiveTab);

activityToggle.addEventListener("click", () => {
  activityOpen = !activityOpen;
  activityToggle.setAttribute("aria-expanded", String(activityOpen));
  toolActivity.classList.toggle("hidden", !activityOpen);
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = {
    baseUrl: value("baseUrl"),
    apiKey: value("apiKey"),
    model: value("model"),
    temperature: Number(value("temperature")),
    maxToolSteps: Number(value("maxToolSteps")),
    appearance: value("appearance"),
    streamResponses: checked("streamResponses"),
    autoStartNetwork: checked("autoStartNetwork"),
    captureResponseBodies: checked("captureResponseBodies"),
    allowCookieWrites: checked("allowCookieWrites"),
    revealSensitiveOnCurrentHost: checked("revealSensitiveOnCurrentHost"),
    systemPrompt: value("systemPrompt")
  };
  settings = await sendMessage({ type: "SAVE_SETTINGS", settings: next });
  applyAppearance(settings.appearance);
  settingsDialog.close();
  updateChrome();
  showActivity("Settings saved", false);
  setTimeout(() => {
    if (!currentRunId) hideActivity();
  }, 1300);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "AGENT_EVENT" || message.runId !== currentRunId) return;
  const { event, payload } = message;

  if (event === "status") {
    const status = String(payload || "Working…");
    headerSubtitle.textContent = status;
    showActivity(status, true);
  }

  if (event === "reasoning_delta") {
    ensureLiveAssistantRow();
    liveDraft.reasoning += String(payload?.delta || "");
    updateLiveReasoning();
    activitySummary.textContent = `Reasoning · step ${payload?.step || 1}`;
  }

  if (event === "assistant_delta") {
    ensureLiveAssistantRow();
    liveDraft.content += String(payload?.delta || "");
    updateLiveContent();
  }

  if (event === "model_step" && Number(payload?.toolCallCount || 0) > 0) {
    // Intermediate text before a tool call is not the final answer.
    if (liveDraft?.content) {
      liveDraft.content = "";
      updateLiveContent();
    }
  }

  if (event === "tool_start") {
    const args = compactArgs(payload.args);
    appendToolLine(`→ ${payload.name}${args ? ` ${args}` : ""}`, "");
    activitySummary.textContent = friendlyToolName(payload.name);
  }

  if (event === "tool_result") {
    appendToolLine(`${payload.ok ? "✓" : "✗"} ${payload.name}: ${payload.result}`, payload.ok ? "success" : "failure");
  }

  if (event === "done") {
    doneEventContent = payload.content;
    addAssistantMessageOnce(payload.content, payload.reasoning).catch(console.error);
    activitySummary.textContent = "Completed";
    activityIndicator.classList.remove("running");
  }

  if (event === "error") {
    headerSubtitle.textContent = "API or agent error";
    activitySummary.textContent = "Something went wrong";
    activityIndicator.classList.remove("running");
  }

  if (event === "cancelled") {
    headerSubtitle.textContent = "Stopped";
    activitySummary.textContent = "Stopped";
    activityIndicator.classList.remove("running");
  }
});

chrome.tabs.onActivated.addListener(() => refreshActiveTab().catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTab?.id && (changeInfo.url || changeInfo.title)) refreshActiveTab().catch(() => {});
});

async function submitPrompt(rawContent) {
  const content = String(rawContent || "").trim();
  if (!content || currentRunId) return;

  if (!settings?.baseUrl || !settings?.model) {
    openSettings();
    return;
  }

  const conversation = getActiveConversation();
  if (!conversation) await startNewChat();
  history.push({ role: "user", content, createdAt: Date.now() });
  autoTitleActiveConversation(content);
  touchActiveConversation();
  promptInput.value = "";
  resizePrompt();
  await persistConversations();
  renderChat();
  renderConversationList();

  currentRunId = crypto.randomUUID();
  doneEventContent = null;
  liveDraft = { content: "", reasoning: "" };
  liveNodes = null;
  resetActivity();
  setRunning(true);

  try {
    const result = await sendMessage({
      type: "RUN_AGENT",
      runId: currentRunId,
      history,
      settings
    });
    if (result?.content && result.content !== doneEventContent) {
      await addAssistantMessageOnce(result.content, result.reasoning);
    }
  } catch (error) {
    const message = normalizeError(error);
    history.push({ role: "error", content: message, createdAt: Date.now() });
    touchActiveConversation();
    await persistConversations();
    liveDraft = null;
    liveNodes = null;
    renderChat();
    appendToolLine(`ERROR: ${message}`, "failure");
  } finally {
    currentRunId = null;
    liveDraft = null;
    liveNodes = null;
    setRunning(false);
    renderConversationList();
  }
}

async function addAssistantMessageOnce(content, reasoning = "") {
  const text = String(content || "").trim();
  const trace = String(reasoning || liveDraft?.reasoning || "").trim();
  if (!text) return;
  const last = history.at(-1);
  if (last?.role === "assistant" && last.content === text) return;
  history.push({ role: "assistant", content: text, reasoning: trace, createdAt: Date.now() });
  touchActiveConversation();
  await persistConversations();
  liveDraft = null;
  liveNodes = null;
  renderChat();
  renderConversationList();
}

async function startNewChat() {
  if (currentRunId) return;
  const conversation = createConversation();
  conversations.unshift(conversation);
  activeConversationId = conversation.id;
  history = conversation.messages;
  await persistConversations();
  resetActivity();
  hideActivity();
  closeDrawer();
  renderChat();
  renderConversationList();
  updateChrome();
  promptInput.focus();
}

async function selectConversation(id) {
  if (currentRunId || id === activeConversationId) {
    closeDrawer();
    return;
  }
  const conversation = conversations.find((item) => item.id === id);
  if (!conversation) return;
  activeConversationId = id;
  history = conversation.messages;
  await persistConversations();
  resetActivity();
  hideActivity();
  renderChat();
  renderConversationList();
  updateChrome();
  closeDrawer();
}

async function deleteConversation(id) {
  if (currentRunId) return;
  const conversation = conversations.find((item) => item.id === id);
  if (!conversation) return;
  if (!confirm(`Delete “${conversation.title}”?`)) return;
  conversations = conversations.filter((item) => item.id !== id);
  if (!conversations.length) conversations = [createConversation()];
  if (!conversations.some((item) => item.id === activeConversationId)) {
    activeConversationId = conversations[0].id;
  }
  history = getActiveConversation().messages;
  await persistConversations();
  renderChat();
  renderConversationList();
  updateChrome();
}

function renderChat() {
  chat.replaceChildren();
  liveNodes = null;

  if (!history.length && !liveDraft) {
    chat.append(createHomeScreen());
    return;
  }

  for (const item of history) {
    if (!item?.content && !item?.reasoning) continue;
    chat.append(createMessageRow(item));
  }

  if (liveDraft) ensureLiveAssistantRow();
  scrollChatToBottom();
}

function createMessageRow(item) {
  const row = document.createElement("article");
  row.className = `message-row ${item.role}`;

  if (item.role === "assistant" || item.role === "error") row.append(createAssistantAvatar());

  if (item.role === "assistant") {
    const stack = document.createElement("div");
    stack.className = "assistant-stack";
    if (item.reasoning) stack.append(createReasoningPanel(item.reasoning));
    const content = document.createElement("div");
    content.className = "message-content";
    renderMarkdown(content, item.content);
    stack.append(content);
    row.append(stack);
  } else {
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = item.content;
    row.append(content);
  }
  return row;
}

function ensureLiveAssistantRow() {
  if (liveNodes || !liveDraft) return liveNodes;
  const row = document.createElement("article");
  row.className = "message-row assistant live-message";
  row.append(createAssistantAvatar());

  const stack = document.createElement("div");
  stack.className = "assistant-stack";
  const reasoningPanel = createReasoningPanel("", true);
  reasoningPanel.classList.add("hidden");
  const reasoningBody = reasoningPanel.querySelector(".reasoning-content");
  const answer = document.createElement("div");
  answer.className = "message-content streaming-content";
  answer.innerHTML = '<span class="typing-caret" aria-label="Generating"></span>';
  stack.append(reasoningPanel, answer);
  row.append(stack);
  chat.append(row);
  liveNodes = { row, stack, reasoningPanel, reasoningBody, answer };
  updateLiveReasoning();
  updateLiveContent();
  scrollChatToBottom();
  return liveNodes;
}

function updateLiveReasoning() {
  if (!liveDraft || !liveNodes) return;
  const hasReasoning = Boolean(liveDraft.reasoning.trim());
  liveNodes.reasoningPanel.classList.toggle("hidden", !hasReasoning);
  if (hasReasoning) renderMarkdown(liveNodes.reasoningBody, liveDraft.reasoning);
  scrollChatToBottom();
}

function updateLiveContent() {
  if (!liveDraft || !liveNodes) return;
  if (liveDraft.content) {
    renderMarkdown(liveNodes.answer, liveDraft.content);
    const caret = document.createElement("span");
    caret.className = "typing-caret";
    liveNodes.answer.append(caret);
  } else {
    liveNodes.answer.innerHTML = '<span class="typing-caret" aria-label="Generating"></span>';
  }
  scrollChatToBottom();
}

function createReasoningPanel(reasoning, live = false) {
  const details = document.createElement("details");
  details.className = `reasoning-panel${live ? " live-reasoning" : ""}`;
  const summary = document.createElement("summary");
  summary.innerHTML = `${brainSvg()}<span>Show reasoning</span><svg class="reasoning-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>`;
  const body = document.createElement("div");
  body.className = "reasoning-content";
  if (reasoning) renderMarkdown(body, reasoning);
  details.append(summary, body);
  details.addEventListener("toggle", () => {
    summary.querySelector("span").textContent = details.open ? "Hide reasoning" : "Show reasoning";
  });
  return details;
}

function createHomeScreen() {
  const home = document.createElement("section");
  home.className = "home-screen";

  const hero = document.createElement("div");
  hero.className = "home-hero";
  hero.innerHTML = `
    <span class="hero-mark" aria-hidden="true">${sparkSvg()}</span>
    <h1>What can I help you with?</h1>
    <p>Ask a question or let the agent read and interact with your current browser page.</p>
  `;

  const list = document.createElement("div");
  list.className = "suggestions";
  for (const suggestion of suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-button";
    button.innerHTML = `${suggestionSvg(suggestion.icon)}<span></span>`;
    button.querySelector("span").textContent = suggestion.label;
    button.addEventListener("click", () => submitPrompt(suggestion.label));
    list.append(button);
  }

  home.append(hero, list);
  return home;
}

function createAssistantAvatar() {
  const avatar = document.createElement("span");
  avatar.className = "assistant-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML = sparkSvg();
  return avatar;
}

function renderConversationList() {
  conversationList.replaceChildren();
  const sorted = [...conversations].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  for (const conversation of sorted) {
    const item = document.createElement("div");
    item.className = `conversation-item${conversation.id === activeConversationId ? " active" : ""}`;

    const select = document.createElement("button");
    select.type = "button";
    select.className = "conversation-select";
    select.innerHTML = `<span class="conversation-name"></span><small>${formatConversationTime(conversation.updatedAt)}</small>`;
    select.querySelector(".conversation-name").textContent = conversation.title || "New conversation";
    select.addEventListener("click", () => selectConversation(conversation.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "conversation-delete";
    remove.title = "Delete conversation";
    remove.setAttribute("aria-label", `Delete ${conversation.title}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>';
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteConversation(conversation.id);
    });

    item.append(select, remove);
    conversationList.append(item);
  }
}

function openDrawer() {
  renderConversationList();
  conversationDrawer.classList.add("open");
  conversationDrawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.classList.remove("hidden");
}

function closeDrawer() {
  conversationDrawer.classList.remove("open");
  conversationDrawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.add("hidden");
}

function setRunning(running) {
  sendButton.disabled = running || !promptInput.value.trim();
  conversationsButton.disabled = running;
  promptInput.disabled = running;
  stopButton.classList.toggle("hidden", !running);
  sendButton.classList.toggle("hidden", running);
  activityIndicator.classList.toggle("running", running);
  headerSubtitle.textContent = running ? "Working on the page…" : activeTabSubtitle();
  if (!running) {
    activitySummary.textContent = activitySummary.textContent === "Completed" ? "Completed" : "Ready";
    activityIndicator.classList.remove("running");
  }
}

function resizePrompt() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(170, Math.max(52, promptInput.scrollHeight))}px`;
  sendButton.disabled = Boolean(currentRunId) || !promptInput.value.trim();
}

function resetActivity() {
  toolActivity.replaceChildren();
  activitySummary.textContent = "Working on the page…";
  activityOpen = false;
  activityToggle.setAttribute("aria-expanded", "false");
  toolActivity.classList.add("hidden");
}

function showActivity(summary, running) {
  activityShell.classList.remove("hidden");
  activitySummary.textContent = summary;
  activityIndicator.classList.toggle("running", Boolean(running));
}

function hideActivity() {
  activityShell.classList.add("hidden");
}

function appendToolLine(text, tone) {
  activityShell.classList.remove("hidden");
  const line = document.createElement("div");
  line.className = `tool-line ${tone || ""}`.trim();
  line.textContent = text;
  toolActivity.append(line);
  toolActivity.scrollTop = toolActivity.scrollHeight;
}

function openSettings() {
  fillSettingsForm();
  settingsDialog.showModal();
  requestAnimationFrame(() => {
    if (settingsBody) settingsBody.scrollTop = 0;
  });
}

function fillSettingsForm() {
  if (!settings) return;
  setValue("baseUrl", settings.baseUrl);
  setValue("apiKey", settings.apiKey);
  setValue("model", settings.model);
  setValue("temperature", settings.temperature);
  setValue("maxToolSteps", settings.maxToolSteps);
  setValue("appearance", settings.appearance || "system");
  setChecked("streamResponses", settings.streamResponses !== false);
  setChecked("autoStartNetwork", settings.autoStartNetwork);
  setChecked("captureResponseBodies", settings.captureResponseBodies);
  setChecked("revealSensitiveOnCurrentHost", settings.revealSensitiveOnCurrentHost);
  setChecked("allowCookieWrites", settings.allowCookieWrites);
  setValue("systemPrompt", settings.systemPrompt);
}

function updateChrome() {
  const configured = Boolean(settings?.baseUrl && settings?.model);
  modelChipText.textContent = settings?.model || "Set model";
  apiStatusDot.classList.toggle("ready", configured);
  headerSubtitle.textContent = currentRunId ? "Working on the page…" : activeTabSubtitle();
  conversationTitle.textContent = getActiveConversation()?.title || "Open Agent";
}

async function refreshActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs.find((tab) => /^https?:\/\//i.test(tab.url || "")) || tabs[0] || null;
  pageChipText.textContent = activeTab ? hostname(activeTab.url) || activeTab.title || "Current page" : "No web page";
  updateChrome();
}

function activeTabSubtitle() {
  const host = hostname(activeTab?.url);
  return host ? `Ready on ${host}` : "Browser assistant";
}

function friendlyToolName(name) {
  return ({
    read_page: "Reading the page…",
    click: "Clicking an element…",
    fill: "Filling a field…",
    select_option: "Selecting an option…",
    press_key: "Pressing a key…",
    scroll_page: "Scrolling the page…",
    wait: "Waiting for the page…",
    navigate: "Opening a page…",
    list_tabs: "Checking browser tabs…",
    switch_tab: "Switching tabs…",
    network_start: "Starting Network capture…",
    network_get: "Reading Network requests…",
    network_clear: "Clearing Network requests…",
    network_stop: "Stopping Network capture…",
    cookies_list: "Reading current-page cookies…",
    cookies_set: "Saving current-page cookie…",
    cookies_import: "Importing current-page cookies…",
    cookies_delete: "Deleting current-page cookie…",
    cookies_delete_all: "Deleting all current-page cookies…"
  })[name] || `Running ${name}…`;
}

function compactArgs(args) {
  if (!args || typeof args !== "object" || !Object.keys(args).length) return "";
  let json;
  try { json = JSON.stringify(args); } catch { return ""; }
  return json.length > 180 ? `${json.slice(0, 177)}…` : json;
}

function renderMarkdown(target, markdown) {
  const raw = String(markdown || "").replace(/\r\n/g, "\n");
  const codeBlocks = [];
  let escaped = escapeHtml(raw).replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.length;
    const lang = escapeHtml(language.trim());
    codeBlocks.push(`<pre><code data-language="${lang}">${code.replace(/^\n|\n$/g, "")}</code></pre>`);
    return `@@CODEBLOCK_${index}@@`;
  });

  escaped = escaped
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  // Extract markdown tables (pipe tables) — wrap in scrollable container.
  // Runs after inline formatting so **bold**, `code`, [links] work inside cells.
  const tableBlocks = [];
  escaped = escaped.replace(/^(\s*\|[^\n]+\n\s*\|[:\-| ]+\n(?:\s*\|[^\n]*\n?)*)/gm, (match) => {
    const index = tableBlocks.length;
    tableBlocks.push(renderTableHtml(match));
    return `@@TABLEBLOCK_${index}@@`;
  });

  const lines = escaped.split("\n");
  const output = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  };

  for (const line of lines) {
    if (/^@@(?:CODEBLOCK|TABLEBLOCK)_\d+@@$/.test(line) || /^<h[1-3]>/.test(line)) {
      flushParagraph();
      closeList();
      output.push(line);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const wanted = unordered ? "ul" : "ol";
      if (listType !== wanted) {
        closeList();
        listType = wanted;
        output.push(`<${wanted}>`);
      }
      output.push(`<li>${(unordered || ordered)[1]}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();

  let html = output.join("");
  html = html.replace(/@@CODEBLOCK_(\d+)@@/g, (_, index) => codeBlocks[Number(index)] || "");
  html = html.replace(/@@TABLEBLOCK_(\d+)@@/g, (_, index) => tableBlocks[Number(index)] || "");
  target.innerHTML = html;

}

function renderTableHtml(markdown) {
  const lines = markdown.trim().split("\n").map((l) => l.trim());
  const headers = lines[0].split("|").map((c) => c.trim()).filter(Boolean);
  const alignRow = lines[1].split("|").map((c) => c.trim()).filter(Boolean);
  const aligns = alignRow.map((cell) => {
    if (/^:?-+:?$/.test(cell)) {
      if (cell.startsWith(":") && cell.endsWith(":")) return ' style="text-align:center"';
      if (cell.endsWith(":")) return ' style="text-align:right"';
      return "";
    }
    return "";
  });
  const rows = lines.slice(2).filter((l) => l.trim().startsWith("|"));
  let html = '<div class="table-wrapper"><table><thead><tr>';
  headers.forEach((h, i) => {
    html += `<th${aligns[i] || ""}>${h}</th>`;
  });
  html += "</tr></thead><tbody>";
  rows.forEach((row) => {
    const cleanCells = row.split("|").slice(1, -1).map((c) => c.trim());
    if (!cleanCells.length) return;
    html += "<tr>";
    cleanCells.forEach((cell, i) => {
      html += `<td${aligns[i] || ""}>${cell}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table></div>";
  return html;
}

async function loadConversations() {
  const stored = await chrome.storage.local.get([CONVERSATIONS_KEY, ACTIVE_CONVERSATION_KEY, LEGACY_HISTORY_KEY]);
  conversations = Array.isArray(stored[CONVERSATIONS_KEY])
    ? stored[CONVERSATIONS_KEY].map(normalizeConversation).filter(Boolean)
    : [];

  if (!conversations.length && Array.isArray(stored[LEGACY_HISTORY_KEY]) && stored[LEGACY_HISTORY_KEY].length) {
    const migrated = createConversation("Imported conversation");
    migrated.messages = stored[LEGACY_HISTORY_KEY].slice(-MAX_MESSAGES_PER_CONVERSATION);
    migrated.updatedAt = Date.now();
    conversations = [migrated];
  }

  if (!conversations.length) conversations = [createConversation()];
  activeConversationId = stored[ACTIVE_CONVERSATION_KEY];
  if (!conversations.some((item) => item.id === activeConversationId)) activeConversationId = conversations[0].id;
  history = getActiveConversation().messages;
  await persistConversations();
}

async function persistConversations() {
  conversations.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  if (conversations.length > MAX_CONVERSATIONS) conversations.splice(MAX_CONVERSATIONS);
  for (const conversation of conversations) {
    if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION);
    }
  }
  await chrome.storage.local.set({
    [CONVERSATIONS_KEY]: conversations,
    [ACTIVE_CONVERSATION_KEY]: activeConversationId
  });
}

function createConversation(title = "New conversation") {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function normalizeConversation(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: String(value.id || crypto.randomUUID()),
    title: String(value.title || "New conversation"),
    createdAt: Number(value.createdAt || Date.now()),
    updatedAt: Number(value.updatedAt || value.createdAt || Date.now()),
    messages: Array.isArray(value.messages) ? value.messages : []
  };
}

function getActiveConversation() {
  return conversations.find((item) => item.id === activeConversationId) || null;
}

function touchActiveConversation() {
  const conversation = getActiveConversation();
  if (!conversation) return;
  conversation.updatedAt = Date.now();
  conversation.messages = history;
}

function autoTitleActiveConversation(firstMessage) {
  const conversation = getActiveConversation();
  if (!conversation || (conversation.title && conversation.title !== "New conversation")) return;
  const cleaned = String(firstMessage).replace(/\s+/g, " ").trim();
  conversation.title = cleaned.length > 46 ? `${cleaned.slice(0, 43)}…` : cleaned || "New conversation";
}

function applyAppearance(appearance) {
  const requested = ["system", "light", "dark"].includes(appearance) ? appearance : "system";
  const resolved = requested === "system" ? (systemThemeQuery.matches ? "dark" : "light") : requested;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.appearance = requested;
}

function formatConversationTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;
    if (atBottom) chat.scrollTop = chat.scrollHeight;
  });
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Extension error");
  return response.result;
}

function normalizeError(error) {
  const message = error?.message || String(error || "Unknown error");
  if (/Failed to fetch/i.test(message)) {
    return "Tidak dapat terhubung ke endpoint API. Periksa Base URL, koneksi, CORS/provider, dan apakah endpoint berakhir di /v1 atau /chat/completions.";
  }
  return message;
}

function renderFatalError(error) {
  history = [{ role: "error", content: `Extension gagal dimuat: ${normalizeError(error)}` }];
  renderChat();
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sparkSvg() {
  return '<svg viewBox="0 0 28 28"><path d="M14 2.7c.9 5.2 3.1 7.4 8.3 8.3-5.2.9-7.4 3.1-8.3 8.3-.9-5.2-3.1-7.4-8.3-8.3 5.2-.9 7.4-3.1 8.3-8.3Z"/><path d="M21.1 17.2c.4 2.2 1.3 3.1 3.5 3.5-2.2.4-3.1 1.3-3.5 3.5-.4-2.2-1.3-3.1-3.5-3.5 2.2-.4 3.1-1.3 3.5-3.5Z"/></svg>';
}

function brainSvg() {
  return '<svg class="reasoning-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 4.5A3 3 0 0 0 5 7.1 3.5 3.5 0 0 0 4.8 14 3 3 0 0 0 9 18.5M14.5 4.5A3 3 0 0 1 19 7.1a3.5 3.5 0 0 1 .2 6.9 3 3 0 0 1-4.2 4.5M9.5 4.5v14M14.5 4.5v14M9.5 9H7.8M14.5 9h1.7M9.5 14H7.8M14.5 14h1.7"/></svg>';
}

function suggestionSvg(type) {
  if (type === "cursor") return '<svg viewBox="0 0 24 24"><path d="m5 3 5.7 15.5 2.2-5.6 5.6-2.2L5 3Z"/><path d="m13.2 13.2 4.1 4.1"/></svg>';
  if (type === "network") return '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h9M5 17h6"/><circle cx="18" cy="16" r="3"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M12 3c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6Z"/><path d="M18 14c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z"/></svg>';
}

function value(id) { return document.getElementById(id).value.trim(); }
function checked(id) { return document.getElementById(id).checked; }
function setValue(id, valueToSet) { document.getElementById(id).value = valueToSet ?? ""; }
function setChecked(id, valueToSet) { document.getElementById(id).checked = Boolean(valueToSet); }
