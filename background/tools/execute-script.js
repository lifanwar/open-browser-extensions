import { acquireDebugger, releaseDebugger, sendDebuggerCommand } from "./debugger-session.js";
import { buildExecutableExpression } from "./script-parser.js";

const MAX_STRING = 10000;
const MAX_ARRAY = 100;

export async function executePageScript(tabId, code) {
  const consumer = Symbol("execute-script");
  let acquired = false;
  try {
    const expression = buildExecutableExpression(code);
    await acquireDebugger(tabId, consumer);
    acquired = true;

    const response = await sendDebuggerCommand(
      tabId,
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      }
    );

    if (response?.exceptionDetails) {
      return {
        ok: false,
        error: response.exceptionDetails.exception?.description
          || response.exceptionDetails.text
          || "Script execution failed"
      };
    }

    return {
      ok: true,
      result: serialize(response?.result?.value)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  } finally {
    if (acquired) await releaseDebugger(tabId, consumer);
  }
}

function serialize(value, depth = 0, seen = new WeakSet()) {
  if (depth > 4) return "[MaxDepth]";
  if (value === undefined) return null;
  if (value === null) return null;

  if (typeof value === "string") return value.slice(0, MAX_STRING);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return "[Function]";

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY).map((v) => serialize(v, depth + 1, seen));
    }

    const output = {};
    Object.keys(value).slice(0, MAX_ARRAY).forEach((key) => {
      try {
        output[key] = serialize(value[key], depth + 1, seen);
      } catch (_) {}
    });
    return output;
  }

  return String(value);
}
