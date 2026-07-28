import assert from "node:assert/strict";

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

const PREFIX = "[User instruction sent during active run]";
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
    get accepting() {
      return accepting;
    },
    get size() {
      return queue.length;
    }
  };
}

function call(id, name = "read_page", args = {}) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

async function runScenario({ queue, complete, execute = async () => ({ ok: true }) }) {
  const snapshots = [];
  const events = [];
  let completionIndex = 0;
  let activeCompletions = 0;
  let maxConcurrentCompletions = 0;

  const result = await runAgent({
    runId: "run-test",
    history: [{ role: "user", content: "Start" }],
    settings: { maxToolSteps: 5, enableSearchTool: false, allowCookieWrites: false },
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

  assert.equal(maxConcurrentCompletions, 1, "A run must never have parallel model requests");
  return { result, snapshots, events, completionCount: completionIndex };
}

// Normal runs preserve the old model -> tool -> model flow.
{
  const queue = createQueueHarness();
  const executed = [];
  const scenario = await runScenario({
    queue,
    complete: async (index) => index === 0
      ? { role: "assistant", content: "", tool_calls: [call("normal-1")] }
      : { role: "assistant", content: "Normal complete" },
    execute: async (name) => {
      executed.push(name);
      return { page: "ok" };
    }
  });
  assert.equal(scenario.result.content, "Normal complete");
  assert.deepEqual(executed, ["read_page"]);
  assert.equal(scenario.completionCount, 2);
  assert.equal(queue.accepting, false, "Final checkpoint must close the queue");
}

// Answer-like text from a tool-calling step must stay buffered. Only the true
// no-tool final response may be published to the UI.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { onDelta }) => {
      if (index === 0) {
        onDelta({ type: "content", delta: "Premature answer" });
        return {
          role: "assistant",
          content: "Premature answer",
          tool_calls: [call("buffered-tool")]
        };
      }
      onDelta({ type: "content", delta: "Actual final answer" });
      return { role: "assistant", content: "Actual final answer" };
    },
    execute: async () => ({ ok: true })
  });

  const published = scenario.events
    .filter(({ event }) => event === "assistant_delta")
    .map(({ payload }) => payload);
  assert.deepEqual(published.map(({ delta }) => delta), ["Actual final answer"]);
  assert.equal(published[0].final, true);
  assert.equal(scenario.result.content, "Actual final answer");
}

// A queued message received during reasoning invalidates the old tool plan before it starts.
{
  const queue = createQueueHarness();
  const executed = [];
  const scenario = await runScenario({
    queue,
    complete: async (index, { onDelta, messages }) => {
      if (index === 0) {
        onDelta({ type: "reasoning", delta: "Planning old action" });
        queue.enqueue("Use the alternate page instead");
        return { role: "assistant", reasoning_content: "Planning old action", tool_calls: [call("reason-old")] };
      }
      if (index === 1) {
        const skipped = JSON.parse(messages.find((message) => message.tool_call_id === "reason-old").content);
        assert.equal(skipped.skipped, true);
        assert.equal(skipped.reason, SKIPPED_REASON);
        assert.equal(messages.at(-1).content, `${PREFIX}\nUse the alternate page instead`);
        assert.match(messages[0].content, /Recreate only unfinished work/i);
        return { role: "assistant", tool_calls: [call("reason-new", "navigate", { url: "https://example.test/alternate", interaction_required: true })] };
      }
      return { role: "assistant", content: "Reasoning steering applied" };
    },
    execute: async (name, args) => {
      executed.push({ name, args });
      return { completed: name };
    }
  });
  assert.deepEqual(executed, [{ name: "navigate", args: { url: "https://example.test/alternate", interaction_required: true } }]);
  assert.equal(scenario.result.content, "Reasoning steering applied");
  assert.ok(scenario.events.some(({ event, payload }) => (
    event === "queue_applied" && payload.phase === "before_tools" && payload.replanRequired === true
  )));
}

// A message queued while content is streaming invalidates the candidate final answer.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { onDelta, messages }) => {
      if (index === 0) {
        onDelta({ type: "content", delta: "Old candidate" });
        queue.enqueue("Include the newly requested detail");
        return { role: "assistant", content: "Old candidate" };
      }
      assert.deepEqual(messages.slice(-2).map((message) => message.role), ["assistant", "user"]);
      assert.equal(messages.at(-2).content, "Old candidate");
      assert.equal(messages.at(-1).content, `${PREFIX}\nInclude the newly requested detail`);
      return { role: "assistant", content: "Updated final answer" };
    }
  });
  assert.equal(scenario.result.content, "Updated final answer");
  assert.ok(scenario.events.some(({ event, payload }) => event === "queue_applied" && payload.phase === "before_final"));
}

// Exact steering case: current extract finishes, pending extract/wait are closed,
// then the model recreates unfinished extract work and changes wait 30s to 5s.
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
          tool_calls: [
            call("extract-old-1", "web_search_tool", { mode: "EXTRACT", url: "https://example.test/1" }),
            call("extract-old-2", "web_search_tool", { mode: "EXTRACT", url: "https://example.test/2" }),
            call("wait-old-30", "wait", { milliseconds: 30000 })
          ]
        };
      }
      if (index === 1) {
        const results = Object.fromEntries(
          messages.filter((message) => message.role === "tool")
            .map((message) => [message.tool_call_id, JSON.parse(message.content)])
        );
        assert.deepEqual(results["extract-old-1"], { extracted: "https://example.test/1" });
        assert.equal(results["extract-old-2"].skipped, true);
        assert.equal(results["wait-old-30"].skipped, true);
        assert.equal(results["wait-old-30"].reason, SKIPPED_REASON);
        assert.equal(messages.at(-1).content, `${PREFIX}\nUpdate waktu tunggu 30 detik menjadi 5 detik`);
        return {
          role: "assistant",
          tool_calls: [
            call("extract-new-2", "web_search_tool", { mode: "EXTRACT", url: "https://example.test/2" }),
            call("wait-new-5", "wait", { milliseconds: 5000 })
          ]
        };
      }
      return { role: "assistant", content: "Extract selesai dan menunggu 5 detik" };
    },
    execute: async (name, args) => {
      executed.push({ name, args });
      if (!queued) {
        queued = true;
        queue.enqueue("Update waktu tunggu 30 detik menjadi 5 detik");
      }
      if (name === "web_search_tool") return { extracted: args.url };
      return { waited: true, milliseconds: args.milliseconds };
    }
  });

  assert.deepEqual(executed, [
    { name: "web_search_tool", args: { mode: "EXTRACT", url: "https://example.test/1" } },
    { name: "web_search_tool", args: { mode: "EXTRACT", url: "https://example.test/2" } },
    { name: "wait", args: { milliseconds: 5000 } }
  ]);
  assert.ok(!executed.some(({ name, args }) => name === "wait" && args.milliseconds === 30000));
  assert.equal(scenario.result.content, "Extract selesai dan menunggu 5 detik");
  assert.ok(scenario.events.some(({ event, payload }) => (
    event === "queue_applied" && payload.phase === "after_tool" && payload.replanRequired === true
  )));
}

// A queue received after the last active tool still forces a model replan before finalization.
{
  const queue = createQueueHarness();
  const executed = [];
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) return { role: "assistant", tool_calls: [call("last-tool", "read_page")] };
      assert.deepEqual(JSON.parse(messages.find((message) => message.tool_call_id === "last-tool").content), { completed: "read_page" });
      assert.equal(messages.at(-1).content, `${PREFIX}\nSummarize only the title`);
      return { role: "assistant", content: "Title only" };
    },
    execute: async (name) => {
      executed.push(name);
      queue.enqueue("Summarize only the title");
      return { completed: name };
    }
  });
  assert.deepEqual(executed, ["read_page"]);
  assert.equal(scenario.result.content, "Title only");
}

// Tool errors are recorded; remaining old tools are closed before replanning.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) return { role: "assistant", tool_calls: [call("error-1"), call("error-2", "scroll_page")] };
      const toolResults = messages.filter((message) => message.role === "tool");
      assert.equal(JSON.parse(toolResults[0].content).error, "tool failed");
      assert.equal(JSON.parse(toolResults[1].content).skipped, true);
      return { role: "assistant", content: "Recovered after tool error" };
    },
    execute: async () => {
      queue.enqueue("Continue using a different action");
      throw new Error("tool failed");
    }
  });
  assert.equal(scenario.result.content, "Recovered after tool error");
}

// Several queued messages are delivered once and in FIFO order.
{
  const queue = createQueueHarness();
  const scenario = await runScenario({
    queue,
    complete: async (index, { messages }) => {
      if (index === 0) {
        queue.enqueue("First instruction");
        queue.enqueue("Second instruction");
        queue.enqueue("Third instruction");
        return { role: "assistant", content: "Candidate" };
      }
      const queuedUsers = messages.filter((message) => message.role === "user" && message.content.startsWith(PREFIX));
      assert.deepEqual(queuedUsers.map((message) => message.content), [
        `${PREFIX}\nFirst instruction`,
        `${PREFIX}\nSecond instruction`,
        `${PREFIX}\nThird instruction`
      ]);
      return { role: "assistant", content: "FIFO complete" };
    }
  });
  assert.equal(scenario.result.content, "FIFO complete");
  assert.equal(queue.size, 0);
}

// Stop during an active tool allows that tool to settle, then prevents later tools/model calls.
{
  const controller = new AbortController();
  const queue = createQueueHarness();
  let completionCount = 0;
  const executed = [];
  await assert.rejects(() => runAgent({
    runId: "run-stop",
    history: [{ role: "user", content: "Start" }],
    settings: { maxToolSteps: 5, enableSearchTool: false, allowCookieWrites: false },
    signal: controller.signal,
    emit: () => {},
    takeQueuedMessages: (options) => queue.take(options),
    getTargetTab: async () => ({ id: 42 }),
    createCompletion: async () => {
      completionCount += 1;
      return { role: "assistant", tool_calls: [call("stop-1"), call("stop-2", "scroll_page")] };
    },
    execute: async (name) => {
      executed.push(name);
      controller.abort();
      return { completed: name };
    }
  }), /Agent dihentikan/);
  assert.equal(completionCount, 1);
  assert.deepEqual(executed, ["read_page"]);
}

// Run-state queue semantics and Stop cleanup.
const {
  createRunState,
  enqueueRunMessage,
  takeQueuedMessages,
  cancelRunState
} = await import(`../background/service-worker.js?test=${Date.now()}`);

{
  const run = createRunState();
  assert.equal(enqueueRunMessage(run, " first "), 1);
  assert.equal(enqueueRunMessage(run, "second"), 2);
  assert.deepEqual(takeQueuedMessages(run), ["first", "second"]);
  assert.deepEqual(takeQueuedMessages(run, { closeIfEmpty: true }), []);
  assert.equal(run.acceptingMessages, false);
  assert.throws(() => enqueueRunMessage(run, "late"), /tidak aktif/i);
  assert.throws(() => enqueueRunMessage(createRunState(), "   "), /tidak boleh kosong/i);
}

{
  const run = createRunState();
  assert.equal(cancelRunState(run), true);
  assert.equal(run.controller.signal.aborted, true);
  assert.deepEqual(run.queue, []);
}

{
  const run = createRunState();
  enqueueRunMessage(run, "discard me");
  assert.equal(cancelRunState(run), true);
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(run.acceptingMessages, false);
  assert.deepEqual(run.queue, []);
  assert.throws(() => enqueueRunMessage(run, "new message"), /tidak aktif/i);

  const nextRun = createRunState();
  enqueueRunMessage(nextRun, "new run only");
  assert.deepEqual(takeQueuedMessages(nextRun), ["new run only"]);
}

console.log("Human-in-the-loop queue, FIFO, replan checkpoints, reasoning, streaming, parameter update, error, concurrency and Stop checks passed.");
