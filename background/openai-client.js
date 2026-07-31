import { credentialValues, redactSensitiveText } from "./credential-store.js";

export function buildChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL is not set.");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export async function createChatCompletion({ settings, messages, tools, signal, onDelta }) {
  const url = buildChatCompletionsUrl(settings.baseUrl);
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const wantsStream = settings.streamResponses !== false;
  const body = {
    model: settings.model,
    messages,
    stream: wantsStream
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const temperature = Number(settings.temperature);
  if (Number.isFinite(temperature)) body.temperature = temperature;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });
  } finally {
    delete headers.Authorization;
  }

  if (!response.ok) {
    const raw = await response.text();
    let data = null;
    try { data = parseCompatibleJson(raw, response.headers.get("content-type") || ""); } catch { /* keep raw */ }
    const detail = data?.error?.message || data?.message || createResponsePreview(raw) || response.statusText;
    throw new Error(`API error ${response.status}: ${redactSensitiveText(detail, credentialValues(settings))}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (wantsStream && response.body) {
    const streamed = await consumeStreamingCompletion(response.body, contentType, onDelta, signal);
    if (streamed) return normalizeAssistantMessage(streamed);
  }

  const raw = await response.text();
  let data;
  try {
    data = parseCompatibleJson(raw, contentType);
  } catch (error) {
    const preview = createResponsePreview(raw);
    throw new Error(
      `API returned a response that could not be processed (${response.status}). ` +
      `${redactSensitiveText(error.message, credentialValues(settings))}\nPreview: ${redactSensitiveText(preview, credentialValues(settings))}`
    );
  }

  const message = normalizeAssistantMessage(extractAssistantMessage(data));
  emitWholeMessage(message, onDelta);
  return message;
}

async function consumeStreamingCompletion(body, contentType, onDelta, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState();
  let buffer = "";
  let raw = "";

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      buffer = consumeCompleteLines(buffer, state, onDelta);
    }

    const tail = decoder.decode();
    raw += tail;
    buffer += tail;
    consumeCompleteLines(`${buffer}\n`, state, onDelta);

    if (state.sawDelta || state.sawCompleteMessage) {
      return buildStreamMessage(state);
    }
  } finally {
    // Ensure stream resources are released on success, abort, or provider errors.
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released by the browser runtime.
    }
  }

  // Some compatible providers ignore stream=true and return one normal JSON body.
  if (raw.trim()) {
    const data = parseCompatibleJson(raw, contentType);
    const message = extractAssistantMessage(data);
    emitWholeMessage(message, onDelta);
    return message;
  }

  throw new Error("API stream ended without a message, delta, or tool call.");
}

function consumeCompleteLines(buffer, state, onDelta) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || "";
  for (const line of lines) processStreamLine(line, state, onDelta);
  return remainder;
}

function processStreamLine(line, state, onDelta) {
  let payload = String(line || "").trim();
  if (!payload || /^event\s*:/i.test(payload) || /^id\s*:/i.test(payload) || /^retry\s*:/i.test(payload)) return;
  payload = payload.replace(/^data\s*:\s?/i, "").trim();
  if (!payload || payload === "[DONE]") return;
  if (!(payload.startsWith("{") || payload.startsWith("["))) return;

  let event;
  try {
    event = JSON.parse(escapeUnquotedControlCharacters(payload));
  } catch {
    const extracted = extractFirstJsonValue(payload);
    if (!extracted) return;
    try { event = JSON.parse(escapeUnquotedControlCharacters(extracted)); } catch { return; }
  }

  applyStreamEvent(event, state, onDelta);
}

function applyStreamEvent(event, state, onDelta) {
  const envelope = unwrapEnvelope(event);
  const choice = envelope?.choices?.[0];
  if (!choice) return;

  if (choice.message) {
    const complete = normalizeAssistantMessage(choice.message);
    state.sawCompleteMessage = true;
    state.role = complete.role || state.role;
    if (complete.content) appendContent(state, complete.content, onDelta);
    if (complete.reasoning_content) appendReasoning(state, complete.reasoning_content, onDelta);
    mergeCompleteToolCalls(state, complete.tool_calls || []);
    return;
  }

  const delta = choice.delta;
  if (!delta) return;
  state.sawDelta = true;
  if (delta.role) state.role = delta.role;

  const content = normalizeDeltaText(delta.content);
  if (content) appendContent(state, content, onDelta);

  const reasoning = normalizeDeltaText(
    delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.reasoning_text
  );
  if (reasoning) appendReasoning(state, reasoning, onDelta);

  for (const part of delta.tool_calls || []) mergeToolCallDelta(state, part);

  if (!delta.tool_calls?.length && delta.function_call?.name) {
    mergeToolCallDelta(state, {
      index: 0,
      id: state.toolCalls.get(0)?.id || "call_0",
      type: "function",
      function: delta.function_call
    });
  }
}

function createStreamState() {
  return {
    role: "assistant",
    content: "",
    reasoning: "",
    toolCalls: new Map(),
    sawDelta: false,
    sawCompleteMessage: false
  };
}

function appendContent(state, delta, onDelta) {
  const text = String(delta || "");
  if (!text) return;
  state.content += text;
  onDelta?.({ type: "content", delta: text });
}

function appendReasoning(state, delta, onDelta) {
  const text = String(delta || "");
  if (!text) return;
  state.reasoning += text;
  onDelta?.({ type: "reasoning", delta: text });
}

function mergeToolCallDelta(state, part) {
  const key = part.index ?? part.id ?? state.toolCalls.size;
  const current = state.toolCalls.get(key) || {
    id: part.id || `call_${key}`,
    type: "function",
    function: { name: "", arguments: "" }
  };
  if (part.id) current.id = part.id;
  if (part.type) current.type = part.type;
  if (part.function?.name) current.function.name += String(part.function.name);
  if (part.function?.arguments) current.function.arguments += String(part.function.arguments);
  state.toolCalls.set(key, current);
}

function mergeCompleteToolCalls(state, calls) {
  calls.forEach((call, index) => {
    state.toolCalls.set(call.index ?? index, {
      id: call.id || `call_${index}`,
      type: call.type || "function",
      function: {
        name: String(call.function?.name || ""),
        arguments: normalizeToolArguments(call.function?.arguments)
      }
    });
  });
}

function buildStreamMessage(state) {
  const message = {
    role: state.role || "assistant",
    content: state.content
  };
  if (state.reasoning) message.reasoning_content = state.reasoning;
  if (state.toolCalls.size) message.tool_calls = [...state.toolCalls.values()];
  return message;
}

function emitWholeMessage(message, onDelta) {
  if (!onDelta || !message) return;
  const content = normalizeDeltaText(message.content);
  const reasoning = normalizeDeltaText(
    message.reasoning_content ?? message.reasoning ?? message.thinking ?? message.reasoning_text
  );
  if (reasoning) onDelta({ type: "reasoning", delta: reasoning });
  if (content) onDelta({ type: "content", delta: content });
}

function extractAssistantMessage(data) {
  const envelope = unwrapEnvelope(data);
  const message = envelope?.choices?.[0]?.message;
  if (!message) {
    throw new Error("API did not return choices[0].message in Chat Completions format.");
  }
  return message;
}

/**
 * Parse responses from OpenAI-compatible providers.
 * Supports JSON, BOM/control bytes, SSE, NDJSON, and trailing proxy text.
 */
export function parseCompatibleJson(raw, contentType = "") {
  const text = String(raw ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) return {};

  const sseLike = /text\/event-stream/i.test(contentType) || /^\s*data\s*:/m.test(text);
  if (sseLike) {
    const parsedSse = parseSsePayload(text);
    if (parsedSse) return parsedSse;
  }

  const candidates = unique([
    text,
    stripCodeFence(text),
    ...extractLineCandidates(text),
    extractFirstJsonValue(text),
    extractFirstJsonValue(stripCodeFence(text))
  ]).filter(Boolean);

  let lastError;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (error) { lastError = error; }
    try { return JSON.parse(escapeUnquotedControlCharacters(candidate)); } catch (error) { lastError = error; }
  }

  throw new Error(lastError?.message || "Unrecognized JSON format.");
}

function parseSsePayload(text) {
  const state = createStreamState();
  for (const line of String(text).split(/\r?\n/)) processStreamLine(line, state);
  if (state.sawDelta || state.sawCompleteMessage) {
    return { choices: [{ index: 0, message: buildStreamMessage(state) }] };
  }
  return null;
}

function unwrapEnvelope(data) {
  let current = data;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current?.choices) return current;
    if (typeof current?.data === "string") {
      try { current = parseCompatibleJson(current.data); continue; } catch { return current; }
    }
    if (current?.data && typeof current.data === "object") {
      current = current.data;
      continue;
    }
    if (current?.response && typeof current.response === "object") {
      current = current.response;
      continue;
    }
    break;
  }
  return current;
}

function normalizeAssistantMessage(message) {
  const normalized = {
    role: message.role || "assistant",
    content: normalizeDeltaText(message.content)
  };

  const reasoning = normalizeDeltaText(
    message.reasoning_content ?? message.reasoning ?? message.thinking ?? message.reasoning_text
  );
  if (reasoning) normalized.reasoning_content = reasoning;

  if (Array.isArray(message.tool_calls)) {
    normalized.tool_calls = message.tool_calls.map((call, index) => ({
      id: call?.id || `call_${crypto.randomUUID?.() || `${Date.now()}_${index}`}`,
      type: call?.type || "function",
      function: {
        name: String(call?.function?.name || call?.name || ""),
        arguments: normalizeToolArguments(call?.function?.arguments ?? call?.arguments)
      }
    }));
  }

  if (!normalized.tool_calls?.length && message.function_call?.name) {
    normalized.tool_calls = [{
      id: `call_${crypto.randomUUID?.() || Date.now()}`,
      type: "function",
      function: {
        name: String(message.function_call.name),
        arguments: normalizeToolArguments(message.function_call.arguments)
      }
    }];
  }

  return normalized;
}

function normalizeDeltaText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      return item?.text ?? item?.content ?? item?.value ?? "";
    }).join("");
  }
  if (value && typeof value === "object") return value.text ?? value.content ?? value.value ?? "";
  return value == null ? "" : String(value);
}

function normalizeToolArguments(value) {
  if (value == null || value === "") return "{}";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function stripCodeFence(text) {
  const match = String(text).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : String(text).trim();
}

function extractLineCandidates(text) {
  const candidates = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^data\s*:\s*/i, "");
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);
  }
  return candidates;
}

function extractFirstJsonValue(text) {
  const input = String(text || "");
  let start = -1;
  let opener = "";
  let closer = "";

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === "{" || input[index] === "[") {
      start = index;
      opener = input[index];
      closer = opener === "{" ? "}" : "]";
      break;
    }
  }
  if (start < 0) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }
  return "";
}

function escapeUnquotedControlCharacters(text) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const char of String(text)) {
    const code = char.charCodeAt(0);
    if (inString) {
      if (escaped) {
        escaped = false;
        output += char;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        output += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        output += char;
        continue;
      }
      if (code < 0x20) {
        const escapedControl = {
          8: "\\b",
          9: "\\t",
          10: "\\n",
          12: "\\f",
          13: "\\r"
        }[code] || `\\u${code.toString(16).padStart(4, "0")}`;
        output += escapedControl;
        continue;
      }
      output += char;
      continue;
    }

    if (char === '"') inString = true;
    if (code < 0x20 && ![9, 10, 13].includes(code)) continue;
    output += char;
  }
  return output;
}

function createResponsePreview(raw) {
  const text = String(raw || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�");
  if (text.length <= 900) return text;
  return `${text.slice(0, 620)} … [${text.length - 820} chars omitted] … ${text.slice(-200)}`;
}

function unique(values) {
  return [...new Set(values)];
}
