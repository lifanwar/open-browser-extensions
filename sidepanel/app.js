const chat = document.querySelector("#chat");
const conversationTitle = document.querySelector("#conversationTitle");
const headerSubtitle = document.querySelector("#headerSubtitle");
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
  headerSubtitle.textContent = "Stopping…";
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
  headerSubtitle.textContent = "Settings saved";
  setTimeout(() => {
    if (!currentRunId) headerSubtitle.textContent = activeTabSubtitle();
  }, 1300);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "AGENT_EVENT" || message.runId !== currentRunId) return;
  const { event, payload } = message;

  if (event === "status") {
    const status = String(payload || "Working…");
    headerSubtitle.textContent = status;
    updateCurrentThinkingLabel(status);
  }

  if (event === "step_start") {
    ensureLiveAssistantRow();
    ensureThinkingActivity(payload?.step || 1, "Thinking…");
  }

  if (event === "reasoning_delta") {
    ensureLiveAssistantRow();
    const delta = String(payload?.delta || "");
    liveDraft.reasoning += delta;
    appendThinkingDelta(payload?.step || 1, delta);
  }

  if (event === "assistant_delta") {
    ensureLiveAssistantRow();
    liveDraft.content += String(payload?.delta || "");
    updateLiveContent();
  }

  if (event === "model_step") {
    completeThinkingActivity(payload?.step || 1);
    if (Number(payload?.toolCallCount || 0) > 0 && liveDraft?.content) {
      // Intermediate text before a tool call is not the final answer.
      liveDraft.content = "";
      updateLiveContent();
    }
  }

  if (event === "tool_start") {
    ensureLiveAssistantRow();
    completeThinkingActivity(payload?.step || 1);
    startToolActivity(payload || {});
    headerSubtitle.textContent = friendlyToolName(payload?.name);
  }

  if (event === "tool_result") {
    finishToolActivity(payload || {});
  }

  if (event === "done") {
    doneEventContent = payload.content;
    finalizeLiveActivities("done");
    const activities = cloneActivities(liveDraft?.activities);
    addAssistantMessageOnce(payload.content, payload.reasoning, activities).catch(console.error);
    headerSubtitle.textContent = "Completed";
  }

  if (event === "error") {
    finalizeLiveActivities("error");
    headerSubtitle.textContent = "API or agent error";
  }

  if (event === "cancelled") {
    finalizeLiveActivities("cancelled");
    headerSubtitle.textContent = "Stopped";
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
  liveDraft = { content: "", reasoning: "", activities: [] };
  liveNodes = null;
  setRunning(true);
  ensureLiveAssistantRow();
  ensureThinkingActivity(1, "Thinking…");

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
    finalizeLiveActivities("error");
    history.push({
      role: "error",
      content: message,
      activities: cloneActivities(liveDraft?.activities),
      createdAt: Date.now()
    });
    touchActiveConversation();
    await persistConversations();
    liveDraft = null;
    liveNodes = null;
    renderChat();
  } finally {
    currentRunId = null;
    liveDraft = null;
    liveNodes = null;
    setRunning(false);
    renderConversationList();
  }
}

async function addAssistantMessageOnce(content, reasoning = "", activities = liveDraft?.activities) {
  const text = String(content || "").trim();
  const trace = String(reasoning || liveDraft?.reasoning || "").trim();
  if (!text) return;
  const last = history.at(-1);
  if (last?.role === "assistant" && last.content === text) return;
  history.push({
    role: "assistant",
    content: text,
    reasoning: trace,
    activities: cloneActivities(activities),
    createdAt: Date.now()
  });
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
    const timeline = createActivityTimeline(item.activities, item.reasoning);
    if (timeline) stack.append(timeline);
    const content = document.createElement("div");
    content.className = "message-content";
    renderMarkdown(content, item.content);
    stack.append(content);
    row.append(stack);
  } else if (item.role === "error" && Array.isArray(item.activities) && item.activities.length) {
    const stack = document.createElement("div");
    stack.className = "assistant-stack";
    const timeline = createActivityTimeline(item.activities);
    if (timeline) stack.append(timeline);
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = item.content;
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
  const timeline = document.createElement("section");
  timeline.className = "agent-timeline live-timeline";
  timeline.setAttribute("aria-label", "Agent activity");
  const answer = document.createElement("div");
  answer.className = "message-content streaming-content hidden";
  stack.append(timeline, answer);
  row.append(stack);
  chat.append(row);
  liveNodes = { row, stack, timeline, answer };
  updateLiveActivities();
  updateLiveContent();
  scrollChatToBottom();
  return liveNodes;
}

function updateLiveActivities() {
  if (!liveDraft || !liveNodes) return;
  renderActivityTimeline(liveNodes.timeline, liveDraft.activities, liveDraft.reasoning, true);
  scrollChatToBottom();
}

function updateLiveContent() {
  if (!liveDraft || !liveNodes) return;
  const hasContent = Boolean(liveDraft.content);
  liveNodes.answer.classList.toggle("hidden", !hasContent);
  if (hasContent) {
    renderMarkdown(liveNodes.answer, liveDraft.content);
    const caret = document.createElement("span");
    caret.className = "typing-caret";
    liveNodes.answer.append(caret);
  } else {
    liveNodes.answer.replaceChildren();
  }
  scrollChatToBottom();
}

function createActivityTimeline(activities, fallbackReasoning = "") {
  const normalized = normalizeActivities(activities, fallbackReasoning);
  if (!normalized.length) return null;
  const timeline = document.createElement("section");
  timeline.className = "agent-timeline";
  timeline.setAttribute("aria-label", "Agent activity");
  renderActivityTimeline(timeline, normalized, fallbackReasoning, false);
  return timeline;
}

function renderActivityTimeline(timeline, activities, fallbackReasoning = "", live = false) {
  const openIds = new Set(
    [...timeline.querySelectorAll("details[open][data-event-id]")]
      .map((node) => node.dataset.eventId)
      .filter(Boolean)
  );
  const normalized = normalizeActivities(activities, fallbackReasoning);
  timeline.replaceChildren();
  timeline.classList.toggle("hidden", !normalized.length);

  for (const activity of normalized) {
    const node = activity.type === "tool"
      ? createToolActivityNode(activity)
      : createThinkingActivityNode(activity, live);
    if (openIds.has(activity.id)) node.open = true;
    timeline.append(node);
  }
}

function createThinkingActivityNode(activity, live) {
  const details = document.createElement("details");
  details.className = `agent-event thinking-event status-${activity.status || "done"}`;
  details.dataset.eventId = activity.id;

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "agent-event-title";
  title.textContent = "Thought process";

  const step = document.createElement("span");
  step.className = "agent-event-pill";
  step.textContent = activity.status === "running"
    ? activity.runningLabel || "Thinking…"
    : activity.label || `Step ${activity.step || 1}`;

  const state = createActivityState(activity.status);
  summary.append(createEventIcon("thinking"), title, step, state, chevronSvgNode());

  const body = document.createElement("div");
  body.className = "agent-event-details reasoning-content";
  if (activity.content) {
    renderMarkdown(body, activity.content);
  } else {
    const note = document.createElement("p");
    note.className = "agent-event-note";
    note.textContent = activity.status === "running" && live
      ? "Waiting for the model to choose the next action."
      : "The provider did not return a reasoning trace for this step.";
    body.append(note);
  }

  details.append(summary, body);
  return details;
}

function createToolActivityNode(activity) {
  const details = document.createElement("details");
  details.className = `agent-event tool-event status-${activity.status || "running"}`;
  details.dataset.eventId = activity.id;

  const presentation = toolPresentation(activity.name, activity.args);
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "agent-event-title";
  title.textContent = presentation.verb;

  const subject = document.createElement("span");
  subject.className = "agent-event-pill";
  subject.title = presentation.subject;
  subject.textContent = presentation.subject;

  summary.append(
    createEventIcon(activity.name),
    title,
    subject,
    createActivityState(activity.status),
    chevronSvgNode()
  );

  const body = document.createElement("div");
  body.className = "agent-event-details";
  appendActivityDetail(body, "Tool", activity.name);

  const args = compactArgs(activity.args, 1200, true);
  if (args) appendActivityDetail(body, "Arguments", args, true);

  if (activity.result) {
    appendActivityDetail(body, activity.status === "error" ? "Error" : "Result", formatResultPreview(activity.result), true);
  }

  details.append(summary, body);
  return details;
}

function createActivityState(status) {
  const state = document.createElement("span");
  state.className = `agent-event-state state-${status || "running"}`;
  if (status === "running") {
    state.innerHTML = '<span class="agent-spinner" aria-label="Running"></span>';
  } else if (status === "error") {
    state.textContent = "Failed";
  } else if (status === "cancelled") {
    state.textContent = "Stopped";
  } else {
    state.textContent = "Done";
  }
  return state;
}

function appendActivityDetail(container, label, value, code = false) {
  const group = document.createElement("div");
  group.className = "agent-detail-group";
  const heading = document.createElement("span");
  heading.className = "agent-detail-label";
  heading.textContent = label;
  const content = document.createElement(code ? "pre" : "p");
  content.textContent = String(value || "");
  group.append(heading, content);
  container.append(group);
}

function normalizeActivities(activities, fallbackReasoning = "") {
  const items = Array.isArray(activities)
    ? activities.filter((item) => item && ["thinking", "tool"].includes(item.type)).map((item, index) => ({
        ...item,
        id: String(item.id || `${item.type}-${index}`)
      }))
    : [];
  const hasThinkingContent = items.some((item) => item.type === "thinking" && String(item.content || "").trim());

  if (fallbackReasoning && !hasThinkingContent) {
    items.unshift({
      id: "legacy-reasoning",
      type: "thinking",
      step: 1,
      label: "Provider reasoning",
      status: "done",
      content: String(fallbackReasoning)
    });
  }
  return items;
}

function ensureThinkingActivity(step = 1, label = "Thinking…", render = true) {
  if (!liveDraft) return null;
  const normalizedStep = Number(step) || 1;
  let activity = liveDraft.activities.find((item) => item.type === "thinking" && item.step === normalizedStep);
  if (!activity) {
    activity = {
      id: `thinking-${normalizedStep}-${Date.now()}`,
      type: "thinking",
      step: normalizedStep,
      label: `Step ${normalizedStep}`,
      status: "running",
      content: "",
      startedAt: Date.now()
    };
    liveDraft.activities.push(activity);
  }
  if (label) activity.runningLabel = label;
  if (render) updateLiveActivities();
  return activity;
}

function appendThinkingDelta(step, delta) {
  const activity = ensureThinkingActivity(step, "Thinking…", false);
  if (!activity) return;
  activity.content += String(delta || "");
  activity.status = "running";
  updateLiveActivities();
}

function updateCurrentThinkingLabel(label) {
  if (!liveDraft) return;
  const current = [...liveDraft.activities].reverse().find((item) => item.type === "thinking" && item.status === "running");
  if (current) current.runningLabel = String(label || "Thinking…");
  updateLiveActivities();
}

function completeThinkingActivity(step) {
  if (!liveDraft) return;
  const activity = [...liveDraft.activities].reverse().find((item) =>
    item.type === "thinking" &&
    (Number(item.step) === Number(step) || item.status === "running")
  );
  if (!activity) return;
  activity.status = "done";
  activity.finishedAt = Date.now();
  updateLiveActivities();
}

function startToolActivity(payload) {
  if (!liveDraft) return;
  const id = String(payload.id || payload.toolCallId || `tool-${Date.now()}-${liveDraft.activities.length}`);
  const existing = liveDraft.activities.find((item) => item.id === id);
  const activity = existing || {
    id,
    type: "tool",
    name: String(payload.name || "unknown_tool"),
    args: sanitizeToolArgs(payload.name, payload.args),
    step: Number(payload.step || 1),
    status: "running",
    startedAt: Date.now()
  };
  if (!existing) liveDraft.activities.push(activity);
  updateLiveActivities();
}

function finishToolActivity(payload) {
  if (!liveDraft) return;
  const id = String(payload.id || payload.toolCallId || "");
  let activity = id ? liveDraft.activities.find((item) => item.id === id) : null;
  if (!activity) {
    activity = [...liveDraft.activities].reverse().find((item) =>
      item.type === "tool" &&
      item.status === "running" &&
      (!payload.name || item.name === payload.name)
    );
  }
  if (!activity) {
    startToolActivity(payload);
    activity = liveDraft.activities.at(-1);
  }
  activity.status = payload.ok === false ? "error" : "done";
  activity.result = truncateText(payload.result, 1600);
  activity.finishedAt = Date.now();
  updateLiveActivities();
}

function finalizeLiveActivities(status = "done") {
  if (!liveDraft) return;
  for (const activity of liveDraft.activities) {
    if (activity.status !== "running") continue;
    activity.status = status === "done" ? "done" : status;
    activity.finishedAt = Date.now();
  }
  updateLiveActivities();
}

function cloneActivities(activities) {
  if (!Array.isArray(activities)) return [];
  return activities.map((activity) => ({
    id: String(activity.id || crypto.randomUUID()),
    type: activity.type,
    step: Number(activity.step || 0) || undefined,
    label: activity.label ? String(activity.label) : undefined,
    name: activity.name ? String(activity.name) : undefined,
    args: activity.args && typeof activity.args === "object" ? structuredCloneSafe(activity.args) : activity.args,
    status: ["running", "done", "error", "cancelled"].includes(activity.status) ? activity.status : "done",
    content: truncateText(activity.content, 12000),
    result: truncateText(activity.result, 1600),
    startedAt: Number(activity.startedAt || 0) || undefined,
    finishedAt: Number(activity.finishedAt || 0) || undefined
  }));
}

function sanitizeToolArgs(name, args) {
  if (!args || typeof args !== "object") return {};
  const clone = structuredCloneSafe(args);
  const redact = (value, key = "") => {
    if (value == null) return value;
    if (/password|secret|token|authorization|api.?key|cookie.*value|cookies_json/i.test(key)) return "[redacted]";
    if (name === "fill" && key === "text") return `[${String(value).length} characters]`;
    if (key === "value" && String(name || "").startsWith("cookies_")) return "[redacted]";
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
    }
    return value;
  };
  return redact(clone);
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
  }
}

function truncateText(value, limit = 1200) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatResultPreview(value) {
  const text = truncateText(value, 1600);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function compactArgs(args, limit = 180, pretty = false) {
  if (!args || typeof args !== "object" || !Object.keys(args).length) return "";
  let json;
  try { json = JSON.stringify(args, null, pretty ? 2 : 0); } catch { return ""; }
  return json.length > limit ? `${json.slice(0, Math.max(0, limit - 1))}…` : json;
}

function toolPresentation(name, args = {}) {
  const currentHost = hostname(activeTab?.url) || "current page";
  const ref = args?.ref ? `Element ${args.ref}` : "page element";
  const map = {
    read_page: ["Read", currentHost],
    click: ["Clicked", ref],
    fill: ["Filled", args?.ref ? `Field ${args.ref}` : "form field"],
    select_option: ["Selected", args?.value || ref],
    press_key: ["Pressed", args?.key || "keyboard key"],
    scroll_page: ["Scrolled", args?.direction || "page"],
    wait: ["Waited", args?.milliseconds ? `${args.milliseconds} ms` : "for page update"],
    navigate: ["Opened", hostname(args?.url) || args?.url || "page"],
    list_tabs: ["Read", "browser tabs"],
    switch_tab: ["Switched", args?.tab_id ? `Tab ${args.tab_id}` : "browser tab"],
    network_start: ["Started", "Network capture"],
    network_get: ["Inspected", args?.url_filter || "Network requests"],
    network_clear: ["Cleared", "Network requests"],
    network_stop: ["Stopped", "Network capture"],
    cookies_list: ["Read", "current-page cookies"],
    cookies_set: ["Saved", args?.cookie?.name || "cookie"],
    cookies_import: ["Imported", "current-page cookies"],
    cookies_delete: ["Deleted", args?.name || "cookie"],
    cookies_delete_all: ["Deleted", "all current-page cookies"]
  };
  const [verb, subject] = map[name] || ["Ran", String(name || "tool").replaceAll("_", " ")];
  return { verb, subject: String(subject || "tool") };
}

function createEventIcon(name) {
  const span = document.createElement("span");
  span.className = "agent-event-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = toolIconSvg(name);
  return span;
}

function chevronSvgNode() {
  const wrapper = document.createElement("span");
  wrapper.className = "agent-event-chevron";
  wrapper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>';
  return wrapper;
}

function toolIconSvg(name) {
  if (name === "thinking") return brainSvg();
  if (name === "read_page" || name === "list_tabs") return '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 9h8M8 13h6"/></svg>';
  if (name === "click") return '<svg viewBox="0 0 24 24"><path d="m5 3 5.7 15.5 2.2-5.6 5.6-2.2L5 3Z"/></svg>';
  if (name === "fill" || name === "select_option") return '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM7 9h10M7 13h6"/></svg>';
  if (name?.startsWith("network_")) return '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h9M5 17h6"/><circle cx="18" cy="16" r="3"/></svg>';
  if (name?.startsWith("cookies_")) return '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-7-7 3 3 0 0 0 4 4 3 3 0 0 0 3 3Z"/><path d="M8 13h.01M12 16h.01M10 9h.01"/></svg>';
  if (name === "navigate" || name === "switch_tab") return '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>';
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
  headerSubtitle.textContent = running ? "Working on the page…" : activeTabSubtitle();
}

function resizePrompt() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(170, Math.max(52, promptInput.scrollHeight))}px`;
  sendButton.disabled = Boolean(currentRunId) || !promptInput.value.trim();
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
