const MAX_STRING = 10000;
const MAX_ARRAY = 100;

export async function executePageScript(tabId, code) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;

    const response = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: `(async()=>{\n${String(code)}\n})()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      }
    );

    if (response?.exceptionDetails) {
      return {
        ok: false,
        error: response.exceptionDetails.exception?.description || "Script execution failed"
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
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch (_) {}
    }
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
