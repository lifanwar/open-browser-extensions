import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  buildChatCompletionsUrl,
  createChatCompletion,
  parseCompatibleJson
} from "../background/openai-client.js";
import { TOOL_DEFINITIONS, getToolDefinitions } from "../background/tool-definitions.js";

assert.equal(buildChatCompletionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
assert.equal(buildChatCompletionsUrl("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1/chat/completions");
assert.equal(buildChatCompletionsUrl("https://example.test/chat/completions"), "https://example.test/chat/completions");
assert.throws(() => buildChatCompletionsUrl(""));

const expectedToolPayload = {
  id: "completion-1",
  object: "chat.completion",
  choices: [{
    index: 0,
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: "",
      reasoning_content: "I will read the current page.",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read_page", arguments: "{}" }
      }]
    }
  }]
};

assert.deepEqual(parseCompatibleJson(JSON.stringify(expectedToolPayload)), expectedToolPayload);
assert.deepEqual(parseCompatibleJson(`\uFEFF${JSON.stringify(expectedToolPayload)}\u0000proxy footer`), expectedToolPayload);

const invalidControl = JSON.stringify(expectedToolPayload).replace(
  "I will read the current page.",
  "I will read\nthe current page."
);
assert.equal(
  parseCompatibleJson(invalidControl).choices[0].message.reasoning_content,
  "I will read\nthe current page."
);

const sse = [
  'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"Checking… ","tool_calls":[{"index":0,"id":"call_sse","type":"function","function":{"name":"read_","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"reasoning_content":"done","tool_calls":[{"index":0,"function":{"name":"page","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
  "data: [DONE]"
].join("\n");
const parsedSse = parseCompatibleJson(sse, "text/event-stream");
assert.equal(parsedSse.choices[0].message.tool_calls[0].function.name, "read_page");
assert.equal(parsedSse.choices[0].message.tool_calls[0].function.arguments, "{}");
assert.equal(parsedSse.choices[0].message.reasoning_content, "Checking… done");

const toolNames = TOOL_DEFINITIONS.map((tool) => tool.function.name);
for (const required of ["read_page", "click", "fill", "network_start", "network_get", "network_stop"]) {
  assert.ok(toolNames.includes(required), `Missing tool ${required}`);
}
assert.equal(new Set(toolNames).size, toolNames.length, "Tool names must be unique");
const toolsWithoutCookieWrites = getToolDefinitions({ allowCookieWrites: false }).map((tool) => tool.function.name);
assert.ok(toolsWithoutCookieWrites.includes("cookies_list"));
for (const name of ["cookies_set", "cookies_import", "cookies_delete", "cookies_delete_all"]) {
  assert.ok(!toolsWithoutCookieWrites.includes(name), `${name} must be omitted when cookie writes are disabled`);
}
const toolsWithCookieWrites = getToolDefinitions({ allowCookieWrites: true }).map((tool) => tool.function.name);
assert.ok(toolsWithCookieWrites.includes("cookies_set"));

let receivedRequest;
const normalDeltas = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    receivedRequest = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
    };
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${JSON.stringify(expectedToolPayload)}\u0000provider-debug-footer`);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const mockMessage = await createChatCompletion({
  settings: {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    model: "deepseek-v4-flash-free",
    temperature: 0.2,
    streamResponses: true
  },
  messages: [{ role: "user", content: "read this page" }],
  tools: TOOL_DEFINITIONS,
  signal: undefined,
  onDelta: (event) => normalDeltas.push(event)
});
server.close();
assert.equal(mockMessage.tool_calls[0].function.name, "read_page");
assert.equal(mockMessage.reasoning_content, "I will read the current page.");
assert.equal(receivedRequest.url, "/v1/chat/completions");
assert.equal(receivedRequest.authorization, "Bearer test-key");
assert.equal(receivedRequest.body.model, "deepseek-v4-flash-free");
assert.equal(receivedRequest.body.tool_choice, "auto");
assert.equal(receivedRequest.body.stream, true);
assert.equal(receivedRequest.body.tools.length, TOOL_DEFINITIONS.length);
assert.equal(normalDeltas.find((item) => item.type === "reasoning")?.delta, "I will read the current page.");


let noToolsRequest;
const noToolsServer = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    noToolsRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "compact memory" } }]
    }));
  });
});
await new Promise((resolve) => noToolsServer.listen(0, "127.0.0.1", resolve));
const noToolsPort = noToolsServer.address().port;
await createChatCompletion({
  settings: {
    baseUrl: `http://127.0.0.1:${noToolsPort}/v1`,
    model: "summary-model",
    streamResponses: false,
    temperature: 0.1
  },
  messages: [{ role: "user", content: "summarize" }],
  tools: []
});
noToolsServer.close();
assert.equal(noToolsRequest.stream, false);
assert.ok(!Object.hasOwn(noToolsRequest, "tools"));
assert.ok(!Object.hasOwn(noToolsRequest, "tool_choice"));

let streamRequest;
const streamDeltas = [];
const streamServer = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    streamRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    response.write('data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"Need to "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"reasoning_content":"inspect.","content":"Result "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"ready."},"finish_reason":"stop"}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve) => streamServer.listen(0, "127.0.0.1", resolve));
const streamPort = streamServer.address().port;
const streamedMessage = await createChatCompletion({
  settings: {
    baseUrl: `http://127.0.0.1:${streamPort}/v1`,
    model: "stream-model",
    streamResponses: true,
    temperature: 0.2
  },
  messages: [{ role: "user", content: "test stream" }],
  tools: TOOL_DEFINITIONS,
  onDelta: (event) => streamDeltas.push(event)
});
streamServer.close();
assert.equal(streamRequest.stream, true);
assert.equal(streamedMessage.content, "Result ready.");
assert.equal(streamedMessage.reasoning_content, "Need to inspect.");
assert.equal(streamDeltas.filter((item) => item.type === "content").map((item) => item.delta).join(""), "Result ready.");
assert.equal(streamDeltas.filter((item) => item.type === "reasoning").map((item) => item.delta).join(""), "Need to inspect.");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.6.1");
assert.equal(manifest.background.type, "module");
assert.ok(manifest.permissions.includes("debugger"));
assert.ok(manifest.permissions.includes("sidePanel"));
assert.equal(manifest.side_panel.default_path, "sidepanel/index.html");

const networkSource = fs.readFileSync(path.join(root, "background/tools/network-debugger.js"), "utf8");
assert.match(networkSource, /"1\.3"/);
assert.doesNotMatch(networkSource, /attach\(\{ tabId \}, "0\.1"\)/);

const sidepanelHtml = fs.readFileSync(path.join(root, "sidepanel/index.html"), "utf8");
assert.ok(sidepanelHtml.includes('<script src="syntax-highlighter.js"></script>'));
assert.ok(sidepanelHtml.indexOf('syntax-highlighter.js') < sidepanelHtml.indexOf('app.js'));
for (const id of ["conversationDrawer", "newConversationButton", "conversationList", "appearance", "streamResponses", "settingsBody", "allowCookieWrites"]) {
  assert.ok(sidepanelHtml.includes(`id="${id}"`), `Missing UI ${id}`);
}
const sidepanelJs = fs.readFileSync(path.join(root, "sidepanel/app.js"), "utf8");
assert.ok(sidepanelJs.includes("SyntaxHighlight?.renderCodeBlock"));
assert.ok(sidepanelJs.includes("writeClipboard"));
assert.ok(sidepanelJs.includes("showCopiedState"));
assert.ok(sidepanelJs.includes("Thought process"));
assert.ok(sidepanelJs.includes("agent-timeline"));
assert.ok(sidepanelJs.includes("tool_start"));
assert.ok(sidepanelJs.includes("reasoning_delta"));
assert.ok(sidepanelJs.includes("thinkingActivityPreview"));
assert.ok(sidepanelJs.includes("const preview = thinkingActivityPreview(activity)"));
assert.ok(sidepanelJs.includes("agentConversations"));
assert.ok(sidepanelJs.includes("QUEUE_AGENT_MESSAGE"));
assert.ok(sidepanelJs.includes("updateComposerControls"));
assert.ok(sidepanelJs.includes('queueStatus: "pending"'));
assert.ok(sidepanelJs.includes("history.indexOf(queuedHistoryMessage)"));
assert.ok(sidepanelJs.includes("const contextSnapshot = structuredClone(getActiveConversation()?.contextState || null)"));
assert.ok(sidepanelJs.includes("contextState: contextSnapshot"));
assert.ok(sidepanelJs.includes("applyConversationContextState"));
assert.ok(!sidepanelJs.includes("promptInput.disabled = running"));
assert.ok(!sidepanelHtml.includes('id="activityShell"'));

const agentSource = fs.readFileSync(path.join(root, "background/agent.js"), "utf8");
assert.ok(agentSource.includes('emit("step_start"'));
assert.ok(agentSource.includes("toolCallId"));
assert.ok(agentSource.includes("[Latest user instruction received during active run]"));
assert.ok(agentSource.includes("[Uncommitted assistant draft]"));
assert.ok(agentSource.includes("requires replanning the remaining tool calls"));
assert.ok(agentSource.includes("Recreate only unfinished work"));
assert.ok(agentSource.includes("replanRequired: true"));
assert.ok(agentSource.includes("Buffer model text until the response is classified"));
assert.ok(agentSource.includes('final: true'));
assert.ok(agentSource.includes("prepareConversationContext"));
assert.ok(agentSource.includes("[Compacted conversation memory]"));
assert.ok(!agentSource.includes("queuedMessagesRequestToolSkip"));

const serviceWorkerSource = fs.readFileSync(path.join(root, "background/service-worker.js"), "utf8");
assert.ok(serviceWorkerSource.includes('case "QUEUE_AGENT_MESSAGE"'));
assert.ok(serviceWorkerSource.includes("queue: []"));
assert.ok(serviceWorkerSource.includes("let emitChain = Promise.resolve()"));
assert.ok(serviceWorkerSource.includes("await emitChain"));
assert.ok(serviceWorkerSource.includes("contextState: message.contextState || null"));

const syntaxHighlighterPath = path.join(root, "sidepanel/syntax-highlighter.js");
const syntaxHighlighterSource = fs.readFileSync(syntaxHighlighterPath, "utf8");
const syntaxContext = vm.createContext({});
vm.runInContext(syntaxHighlighterSource, syntaxContext);
const syntax = syntaxContext.SyntaxHighlight;
assert.ok(syntax, "SyntaxHighlight must be attached globally");
assert.equal(syntax.normalizeLanguage("JS"), "javascript");
assert.equal(syntax.normalizeLanguage("yml"), "yaml");
const highlightedJs = syntax.renderCodeBlock('const answer = 42; // safe', 'js');
assert.match(highlightedJs, /code-block-toolbar/);
assert.match(highlightedJs, /tok-keyword/);
assert.match(highlightedJs, /tok-number/);
assert.match(highlightedJs, /tok-comment/);
assert.match(highlightedJs, />JavaScript</);
const highlightedMarkup = syntax.renderCodeBlock('<script>alert("x")<\/script>', 'html');
assert.ok(!highlightedMarkup.includes('<script>'), "Highlighted source must not inject executable markup");
assert.match(highlightedMarkup, /tok-tag/);
assert.doesNotMatch(syntaxHighlighterSource, /eval\s*\(/);

const requiredFiles = [
  "background/service-worker.js",
  "background/agent.js",
  "background/context-compaction.js",
  "background/tools/browser-tools.js",
  "background/tools/cookie-tools.js",
  "background/tools/execute-script.js",
  "background/tools/network-debugger.js",
  "background/tools/search-tool.js",
  "content/browser.js",
  "sidepanel/index.html",
  "sidepanel/syntax-highlighter.js",
  "sidepanel/app.js"
];
for (const file of requiredFiles) assert.ok(fs.existsSync(path.join(root, file)), `Missing ${file}`);

const sourceFiles = [
  ...listJavaScriptFiles(path.join(root, "background")),
  path.join(root, "content/browser.js"),
  path.join(root, "sidepanel/app.js")
];
for (const sourceFile of sourceFiles) {
  const source = fs.readFileSync(sourceFile, "utf8");
  assert.ok(source.includes("\n"), `${sourceFile} appears minified`);
  assert.ok(!/eval\s*\(/.test(source), `${sourceFile} must not use eval`);
}


function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
  });
}

console.log("Static, CDP protocol, conversations, cookie tool gating, settings layout, parser and streaming checks passed.");
