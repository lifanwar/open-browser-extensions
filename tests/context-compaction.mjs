import assert from "node:assert/strict";
import {
  normalizeContextState,
  prepareConversationContext,
  sanitizeConversationHistory
} from "../background/context-compaction.js";

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
    sendMessage: async () => ({})
  },
  debugger: {
    onEvent: { addListener() {} },
    onDetach: { addListener() {} }
  },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: { local: { get: async () => ({}), set: async () => {} } }
};

const { runAgent } = await import("../background/agent.js");

function message(id, role, content) {
  return { id, role, content, createdAt: Number(id.replace(/\D/g, "")) || 1 };
}

// Short conversations keep the exact existing request path and do not spend an
// extra model call on compaction.
{
  let calls = 0;
  const history = [
    message("m1", "user", "Hello"),
    message("m2", "assistant", "Hi"),
    { id: "m3", role: "error", content: "ignored" }
  ];
  const result = await prepareConversationContext({
    history,
    settings: {},
    createCompletion: async () => {
      calls += 1;
      return { content: "unused" };
    }
  });

  assert.equal(calls, 0);
  assert.equal(result.compacted, false);
  assert.equal(result.contextState, null);
  assert.deepEqual(result.messages, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" }
  ]);
}

// A long history is summarized once, while a coherent recent window remains
// verbatim for the normal agent request.
let compactedState;
let longHistory;
{
  longHistory = Array.from({ length: 20 }, (_, index) => message(
    `m${index + 1}`,
    index % 2 === 0 ? "user" : "assistant",
    `${index % 2 === 0 ? "User" : "Assistant"} turn ${index + 1}: ${"x".repeat(1900)}`
  ));
  const events = [];
  let summaryRequest;
  const result = await prepareConversationContext({
    history: longHistory,
    settings: { model: "test-model", streamResponses: true, temperature: 0.7 },
    emit: (event, payload) => events.push({ event, payload }),
    createCompletion: async (request) => {
      summaryRequest = request;
      return {
        role: "assistant",
        content: "Goal: continue the browser-extension project.\nDecisions: preserve existing agent flow."
      };
    }
  });

  compactedState = result.contextState;
  assert.equal(result.compacted, true);
  assert.equal(summaryRequest.tools.length, 0);
  assert.equal(summaryRequest.settings.streamResponses, false);
  assert.equal(summaryRequest.settings.temperature, 0.1);
  assert.match(summaryRequest.messages[0].content, /untrusted conversation data/i);
  assert.match(summaryRequest.messages[1].content, /User turn 1/);
  assert.match(result.messages[0].content, /^\[Compacted conversation memory\]/);
  assert.ok(result.messages.length < longHistory.length);
  assert.equal(compactedState.compactedThroughId, "m12");
  assert.ok(events.some(({ event }) => event === "context_compacted"));
}

// On the next run, already compacted raw turns are not sent again. Only the
// persisted memory and messages after the stable boundary are used.
{
  let calls = 0;
  const result = await prepareConversationContext({
    history: longHistory,
    contextState: compactedState,
    settings: {},
    createCompletion: async () => {
      calls += 1;
      return { content: "unused" };
    }
  });

  assert.equal(calls, 0);
  assert.equal(result.compacted, false);
  assert.equal(result.messages.length, 9);
  assert.match(result.messages[0].content, /^\[Compacted conversation memory\]/);
  assert.match(result.messages[1].content, /turn 13/);
  assert.ok(!result.messages.some((item) => item.content.includes("turn 1:")));
}

// Agent integration: the optional summary call happens before the unchanged
// tool-capable model loop, and the final state is returned for local persistence.
{
  const requests = [];
  const result = await runAgent({
    runId: "context-integration",
    history: longHistory,
    settings: {
      model: "test-model",
      maxToolSteps: 2,
      enableSearchTool: false,
      allowCookieWrites: false,
      streamResponses: true,
      temperature: 0.2
    },
    signal: new AbortController().signal,
    emit: () => {},
    takeQueuedMessages: () => [],
    getTargetTab: async () => ({ id: 42 }),
    execute: async () => ({ ok: true }),
    createCompletion: async (request) => {
      requests.push(request);
      if (!request.tools?.length) {
        return { role: "assistant", content: "Goal: preserve the extension behavior." };
      }
      assert.match(request.messages[1].content, /^\[Compacted conversation memory\]/);
      return { role: "assistant", content: "Final answer" };
    }
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools.length, 0);
  assert.ok(requests[1].tools.length > 0);
  assert.equal(result.content, "Final answer");
  assert.ok(result.contextState?.summary);
}

// Compaction is optional: an incompatible provider falls back to the exact
// sanitized history instead of breaking the existing agent.
{
  const events = [];
  const result = await prepareConversationContext({
    history: longHistory,
    settings: {},
    emit: (event, payload) => events.push({ event, payload }),
    createCompletion: async () => {
      throw new Error("summary unsupported");
    }
  });

  assert.equal(result.compacted, false);
  assert.equal(result.contextState, null);
  assert.equal(result.messages.length, longHistory.length);
  assert.ok(events.some(({ event }) => event === "context_compaction_skipped"));
}

assert.equal(normalizeContextState({ summary: "", compactedThroughId: "m1" }), null);
assert.equal(sanitizeConversationHistory([{ role: "tool", content: "hidden" }]).length, 0);

console.log("Context compaction, persisted boundary, recent-window and fallback checks passed.");
