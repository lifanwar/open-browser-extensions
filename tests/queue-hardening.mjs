import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

let serviceWorkerMessageListener;
const listenerTarget = (capture = () => {}) => ({ addListener(listener) { capture(listener); } });

globalThis.chrome = {
  runtime: {
    id: "queue-test-extension",
    getURL: (value = "") => `chrome-extension://queue-test-extension/${value}`,
    onInstalled: listenerTarget(),
    onStartup: listenerTarget(),
    onMessage: listenerTarget((listener) => { serviceWorkerMessageListener = listener; }),
    sendMessage: async () => ({})
  },
  debugger: {
    onEvent: listenerTarget(),
    onDetach: listenerTarget()
  },
  tabs: { onRemoved: listenerTarget() },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: { local: { get: async () => ({}), set: async () => {} } }
};

const { runAgent } = await import(`../background/agent.js?queue-hardening=${Date.now()}`);
await import(`../background/service-worker.js?queue-hardening=${Date.now()}`);

const LATEST_PREFIX = "[Latest user instruction received during active run]";
const BATCH_PREFIX = "[Latest user instructions received during active run; apply in order, last wins on conflicts]";
const DRAFT_PREFIX = "[Uncommitted assistant draft]";
const SKIPPED_REASON = "Skipped because a newer user instruction requires replanning the remaining tool calls.";

function createQueueHarness(initial = []) {
  const queue = [...initial];
  let accepting = true;
  return {
    enqueue(content) {
      if (!accepting) throw new Error("queue closed");
      queue.push(String(content));
    },
    take({ closeIfEmpty = false } = {}) {
      if (queue.length) return queue.splice(0, queue.length);
      if (closeIfEmpty) accepting = false;
      return [];
    },
    get accepting() { return accepting; },
    get size() { return queue.length; }
  };
}

function call(id, name = "read_page", args = {}) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

async function runScenario({
  queue = createQueueHarness(),
  complete,
  execute = async () => ({ ok: true }),
  settings = {}
}) {
  const events = [];
  const snapshots = [];
  let completionIndex = 0;
  let activeCompletions = 0;
  let maxConcurrentCompletions = 0;

  const result = await runAgent({
    runId: "queue-hardening-run",
    history: [{ role: "user", content: "Original request" }],
    settings: {
      maxToolSteps: 5,
      enableSearchTool: false,
      allowCookieWrites: false,
      ...settings
    },
    signal: new AbortController().signal,
    emit: (event, payload) => events.push({ event, payload }),
    takeQueuedMessages: (options) => queue.take(options),
    getTargetTab: async () => ({ id: 42 }),
    createCompletion: async ({ messages, onDelta }) => {
      activeCompletions += 1;
      maxConcurrentCompletions = Math.max(maxConcurrentCompletions, activeCompletions);
      snapshots.push(structuredClone(messages));
      try {
        return await complete(completionIndex++, { messages, onDelta });
      } finally {
        activeCompletions -= 1;
      }
    },
    execute
  });

  assert.equal(maxConcurrentCompletions, 1, "Model completions must stay sequential");
  return { result, events, snapshots, completionCount: completionIndex, queue };
}

// 1-3: A new question wins, the discarded candidate remains reference-only,
// and old reasoning does not leak into the returned final trace.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages, onDelta }) => {
      if (index === 0) {
        onDelta({ type: "reasoning", delta: "Old question reasoning" });
        onDelta({ type: "content", delta: "Old answer candidate" });
        queue.enqueue("What is the latest queued question?");
        return {
          role: "assistant",
          content: "Old answer candidate",
          reasoning_content: "Old question reasoning"
        };
      }

      assert.match(messages[0].content, /Uncommitted assistant draft/);
      assert.match(messages[0].content, /overrides conflicting earlier requests/);
      assert.deepEqual(messages.slice(-2).map(({ role }) => role), ["assistant", "user"]);
      assert.equal(messages.at(-2).content, `${DRAFT_PREFIX}\nOld answer candidate`);
      assert.ok(!("reasoning_content" in messages.at(-2)));
      assert.equal(messages.at(-1).content, `${LATEST_PREFIX}\nWhat is the latest queued question?`);
      onDelta({ type: "reasoning", delta: "New question reasoning" });
      return { role: "assistant", content: "Latest question answered", reasoning_content: "New question reasoning" };
    }
  });

  assert.equal(scenario.result.content, "Latest question answered");
  assert.match(scenario.result.reasoning, /New question reasoning/);
  assert.doesNotMatch(scenario.result.reasoning, /Old question reasoning/);
}

// 4: Steering that refers to generated output still has the draft available.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) {
        queue.enqueue("Use option 2 and create a tagline");
        return { role: "assistant", content: "1. Arunika\n2. Velora\n3. Nuvexa" };
      }
      assert.equal(messages.at(-2).content, `${DRAFT_PREFIX}\n1. Arunika\n2. Velora\n3. Nuvexa`);
      assert.equal(messages.at(-1).content, `${LATEST_PREFIX}\nUse option 2 and create a tagline`);
      return { role: "assistant", content: "Velora — Move with clarity" };
    }
  });
  assert.equal(scenario.result.content, "Velora — Move with clarity");
}

// 5: Repeated steering keeps the newest draft directly adjacent to the newest instruction.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) {
        queue.enqueue("Reduce it to two paragraphs");
        return { role: "assistant", content: "Draft version one" };
      }
      if (index === 1) {
        assert.equal(messages.at(-2).content, `${DRAFT_PREFIX}\nDraft version one`);
        queue.enqueue("Make paragraph two formal");
        return { role: "assistant", content: "Draft version two with two paragraphs" };
      }
      assert.equal(messages.at(-2).content, `${DRAFT_PREFIX}\nDraft version two with two paragraphs`);
      assert.equal(messages.at(-1).content, `${LATEST_PREFIX}\nMake paragraph two formal`);
      return { role: "assistant", content: "Final formal two-paragraph result" };
    }
  });
  assert.equal(scenario.result.content, "Final formal two-paragraph result");
  assert.equal(scenario.completionCount, 3);
}

// 6: A queued instruction before tools strips stale model prose/reasoning and skips the old plan.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) {
        queue.enqueue("First instruction");
        queue.enqueue("Second instruction");
        queue.enqueue("Third instruction");
        return { role: "assistant", content: "Batch candidate" };
      }
      assert.deepEqual(messages.slice(-2).map((message) => message.role), ["assistant", "user"]);
      assert.equal(messages.at(-1).content, `${BATCH_PREFIX}\n1. First instruction\n2. Second instruction\n3. Third instruction`);
      return { role: "assistant", content: "Batch applied in order" };
    }
  });
  assert.equal(scenario.result.content, "Batch applied in order");
}

// 7: A queued instruction before tools strips stale model prose/reasoning and skips the old plan.
{
  const queue = createQueueHarness();
  const executed = [];
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) {
        queue.enqueue("Navigate to the alternate page");
        return {
          role: "assistant",
          content: "Old answer-like prose",
          reasoning_content: "Old tool reasoning",
          tool_calls: [call("old-tool", "navigate", { url: "https://old.test", interaction_required: true })]
        };
      }
      if (index === 1) {
        const assistantTool = messages.find((message) => message.role === "assistant" && message.tool_calls);
        assert.equal(assistantTool.content, null);
        assert.ok(!("reasoning_content" in assistantTool));
        assert.equal(JSON.parse(messages.find((message) => message.tool_call_id === "old-tool").content).reason, SKIPPED_REASON);
        return {
          role: "assistant",
          tool_calls: [call("new-tool", "navigate", { url: "https://alternate.test", interaction_required: true })]
        };
      }
      return { role: "assistant", content: "Alternate page opened" };
    },
    execute: async (name, args) => {
      executed.push({ name, args });
      return { ok: true };
    }
  });
  assert.deepEqual(executed, [{ name: "navigate", args: { url: "https://alternate.test", interaction_required: true } }]);
  assert.doesNotMatch(scenario.result.reasoning, /Old tool reasoning/);
}

// 8: Queueing after one tool preserves completed work, strips stale assistant trace,
// and skips only the unfinished old tools.
{
  const queue = createQueueHarness();
  const executed = [];
  let queued = false;
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) {
        return {
          role: "assistant",
          content: "Old tool-plan prose",
          reasoning_content: "Old after-tool reasoning",
          tool_calls: [call("done-tool"), call("pending-tool", "scroll_page")]
        };
      }
      const assistantTool = messages.find((message) => message.role === "assistant" && message.tool_calls);
      assert.equal(assistantTool.content, null);
      assert.ok(!("reasoning_content" in assistantTool));
      assert.deepEqual(JSON.parse(messages.find((message) => message.tool_call_id === "done-tool").content), { completed: "read_page" });
      assert.equal(JSON.parse(messages.find((message) => message.tool_call_id === "pending-tool").content).skipped, true);
      return { role: "assistant", content: "Replanned after completed tool" };
    },
    execute: async (name) => {
      executed.push(name);
      if (!queued) {
        queued = true;
        queue.enqueue("Do not scroll; summarize the current page");
      }
      return { completed: name };
    }
  });
  assert.deepEqual(executed, ["read_page"]);
  assert.equal(scenario.result.content, "Replanned after completed tool");
  assert.doesNotMatch(scenario.result.reasoning, /Old after-tool reasoning/);
}

// 9: Drafts are already redacted before being reused as context.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    settings: { apiKey: "secret-token-123" },
    complete: async (index, { messages }) => {
      if (index === 0) {
        queue.enqueue("Rewrite without the credential");
        return { role: "assistant", content: "Credential: secret-token-123" };
      }
      assert.equal(messages.at(-2).content, `${DRAFT_PREFIX}\nCredential: [REDACTED API KEY]`);
      assert.ok(!JSON.stringify(messages).includes("secret-token-123"));
      return { role: "assistant", content: "Credential removed" };
    }
  });
  assert.equal(scenario.result.content, "Credential removed");
}

// 10: Many reroutes remain sequential, finite, FIFO, and are allowed beyond the base step cap.
{
  const queue = createQueueHarness();
  const reroutes = 25;
  const scenario = await runScenario({
    queue,
    settings: { maxToolSteps: 1 },
    complete: async (index, { messages }) => {
      if (index < reroutes) {
        queue.enqueue(`Instruction ${index + 1}`);
        return { role: "assistant", content: `Candidate ${index + 1}` };
      }
      const queued = messages.filter((message) => message.role === "user" && message.content.startsWith(LATEST_PREFIX));
      assert.equal(queued.length, reroutes);
      assert.deepEqual(
        queued.map((message) => message.content),
        Array.from({ length: reroutes }, (_, item) => `${LATEST_PREFIX}\nInstruction ${item + 1}`)
      );
      return { role: "assistant", content: "Stress reroute complete" };
    }
  });
  assert.equal(scenario.result.content, "Stress reroute complete");
  assert.equal(scenario.completionCount, reroutes + 1);
  assert.equal(scenario.queue.size, 0);
  assert.equal(scenario.queue.accepting, false);
}

// 11: A message arriving after the final queue checkpoint is explicitly retried as a new run.
{
  const response = await new Promise((resolve) => {
    const keepAlive = serviceWorkerMessageListener(
      { type: "QUEUE_AGENT_MESSAGE", runId: "already-finished", content: "Late question" },
      {},
      resolve
    );
    assert.equal(keepAlive, true);
  });
  assert.deepEqual(response, {
    ok: true,
    result: { accepted: false, runId: "already-finished", retryAsNewRun: true }
  });
}

// UI/lifecycle checks: clear stale draft reasoning, freeze request snapshots,
// ignore stale results, and drain a rejected late queue after the current run.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const sidepanel = fs.readFileSync(path.join(root, "sidepanel/app.js"), "utf8");
  const serviceWorker = fs.readFileSync(path.join(root, "background/service-worker.js"), "utf8");

  const queueEventStart = sidepanel.indexOf('if (event === "queue_applied")');
  const queueEventEnd = sidepanel.indexOf('if (event === "tool_start")', queueEventStart);
  const queueEvent = sidepanel.slice(queueEventStart, queueEventEnd);
  assert.match(queueEvent, /liveDraft\.content = ""/);
  assert.match(queueEvent, /liveDraft\.reasoning = ""/);

  const submitStart = sidepanel.indexOf("async function submitPrompt");
  const queueStart = sidepanel.indexOf("async function queuePrompt", submitStart);
  const submit = sidepanel.slice(submitStart, queueStart);
  assert.ok(submit.indexOf("currentRunId = runId") < submit.indexOf("await persistConversations()"));
  assert.match(submit, /const historySnapshot = structuredClone\(history\)/);
  assert.match(submit, /const contextSnapshot = structuredClone/);
  assert.match(submit, /history: historySnapshot/);
  assert.match(submit, /contextState: contextSnapshot/);
  assert.match(submit, /currentRunId !== runId \|\| activeConversationId !== conversationId/);
  assert.match(submit, /if \(currentRunId === runId\)/);
  assert.match(sidepanel, /deferredPrompts\.push\(content\)/);
  assert.match(sidepanel, /async function submitDeferredPrompt/);
  assert.match(serviceWorker, /retryAsNewRun: true/);

  const queuePromptStart = sidepanel.indexOf("async function queuePrompt");
  const queuePromptEnd = sidepanel.indexOf("async function addAssistantMessageOnce", queuePromptStart);
  const queuePromptSource = sidepanel.slice(queuePromptStart, queuePromptEnd);
  const submitted = [];
  const uiContext = vm.createContext({
    currentRunId: "closing-run",
    queueSubmissionPending: false,
    deferredPrompts: [],
    history: [],
    promptInput: { value: "Late question" },
    headerSubtitle: { textContent: "" },
    sendMessage: async () => ({ accepted: false, retryAsNewRun: true }),
    touchActiveConversation() {},
    renderChat() {},
    renderConversationList() {},
    updateComposerControls() {},
    resizePrompt() {},
    persistConversations: async () => {},
    normalizeError: (error) => error?.message || String(error),
    submitPrompt: async (content) => { submitted.push(content); }
  });
  vm.runInContext(`${queuePromptSource}\nglobalThis.queuePrompt = queuePrompt; globalThis.submitDeferredPrompt = submitDeferredPrompt;`, uiContext);
  await uiContext.queuePrompt("Late question", "Late question");
  assert.deepEqual(uiContext.history, []);
  assert.deepEqual(uiContext.deferredPrompts, ["Late question"]);
  assert.equal(uiContext.promptInput.value, "");
  assert.deepEqual(submitted, []);
  uiContext.currentRunId = null;
  await uiContext.submitDeferredPrompt();
  assert.deepEqual(submitted, ["Late question"]);
  assert.deepEqual(uiContext.deferredPrompts, []);

  const submitFunctionStart = sidepanel.indexOf("async function submitPrompt");
  const submitEnd = sidepanel.indexOf("async function queuePrompt", submitFunctionStart);
  const submitSource = sidepanel.slice(submitFunctionStart, submitEnd);
  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });
  const queuedDuringSetup = [];
  const addedAnswers = [];
  const sentPayloads = [];
  const submitContext = vm.createContext({
    settings: { baseUrl: "https://api.test", model: "test" },
    currentRunId: null,
    activeConversationId: "conversation-1",
    history: [],
    doneEventContent: null,
    liveDraft: null,
    liveNodes: null,
    promptInput: { value: "" },
    crypto: globalThis.crypto,
    structuredClone,
    getActiveConversation: () => ({ contextState: null }),
    startNewChat: async () => {},
    queuePrompt: null,
    openSettings() {},
    autoTitleActiveConversation() {},
    touchActiveConversation() {},
    resizePrompt() {},
    persistConversations: async () => { await persistGate; },
    renderChat() {},
    renderConversationList() {},
    setRunning() {},
    ensureLiveAssistantRow() {},
    ensureThinkingActivity() {},
    sendMessage: async (payload) => {
      sentPayloads.push(structuredClone(payload));
      return { content: "First answer", contextState: null };
    },
    applyConversationContextState: () => false,
    addAssistantMessageOnce: async (content) => { addedAnswers.push(content); },
    normalizeError: (error) => error?.message || String(error),
    finalizeLiveActivities() {},
    cloneActivities: () => [],
    submitDeferredPrompt: async () => {}
  });
  submitContext.queuePrompt = async (_raw, content) => {
    queuedDuringSetup.push(content);
    submitContext.history.push({ role: "user", content });
  };
  vm.runInContext(`${submitSource}\nglobalThis.submitPrompt = submitPrompt;`, submitContext);
  const firstSubmit = submitContext.submitPrompt("First question");
  await submitContext.submitPrompt("Second question");
  assert.deepEqual(queuedDuringSetup, ["Second question"], "A second submit during persistence must queue, not start a parallel run");
  releasePersist();
  await firstSubmit;
  assert.deepEqual(addedAnswers, ["First answer"]);
  assert.deepEqual(sentPayloads[0].history.map((message) => message.content), ["First question"]);
  assert.equal(submitContext.currentRunId, null);

  let releaseRequest;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  const staleAnswers = [];
  const staleContext = vm.createContext({
    ...submitContext,
    currentRunId: null,
    history: [],
    persistConversations: async () => {},
    sendMessage: async () => requestGate,
    addAssistantMessageOnce: async (content) => { staleAnswers.push(content); }
  });
  vm.runInContext(`${submitSource}\nglobalThis.submitPrompt = submitPrompt;`, staleContext);
  const staleSubmit = staleContext.submitPrompt("Old run");
  await Promise.resolve();
  staleContext.currentRunId = "replacement-run";
  releaseRequest({ content: "Stale answer", contextState: null });
  await staleSubmit;
  assert.deepEqual(staleAnswers, []);
  assert.equal(staleContext.currentRunId, "replacement-run", "An old finally block must not clear a replacement run");

  const addStart = sidepanel.indexOf("async function addAssistantMessageOnce");
  const addEnd = sidepanel.indexOf("async function startNewChat", addStart);
  const addSource = sidepanel.slice(addStart, addEnd);
  let releaseAddPersist;
  const addPersistGate = new Promise((resolve) => { releaseAddPersist = resolve; });
  const replacementDraft = { content: "Replacement run", reasoning: "", activities: [] };
  const addContext = vm.createContext({
    currentRunId: "old-run",
    history: [],
    liveDraft: { content: "Old run", reasoning: "", activities: [] },
    liveNodes: { row: {} },
    cloneActivities: () => [],
    touchActiveConversation() {},
    persistConversations: async () => addPersistGate,
    renderChat() {},
    renderConversationList() {}
  });
  vm.runInContext(`${addSource}\nglobalThis.addAssistantMessageOnce = addAssistantMessageOnce;`, addContext);
  const oldFinalizer = addContext.addAssistantMessageOnce("Old answer", "", [], "old-run");
  addContext.currentRunId = "replacement-run";
  addContext.liveDraft = replacementDraft;
  releaseAddPersist();
  await oldFinalizer;
  assert.equal(addContext.liveDraft, replacementDraft, "An old async finalizer must not clear the replacement run draft");
}

console.log("Queue hardening: latest-message priority, draft references, reasoning reset, tool replanning, redaction, stress, late-queue retry and stale-run UI checks passed.");
