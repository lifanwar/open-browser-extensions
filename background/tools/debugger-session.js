const sessions = new Map();
const SUPPORTED_PROTOCOL_VERSIONS = ["1.3", "1.2", "1.1"];

function sessionFor(tabId) {
  if (!sessions.has(tabId)) {
    sessions.set(tabId, {
      attached: false,
      protocolVersion: "",
      consumers: new Set(),
      operation: Promise.resolve()
    });
  }
  return sessions.get(tabId);
}

function enqueue(session, operation) {
  const next = session.operation.then(operation, operation);
  session.operation = next.catch(() => {});
  return next;
}

export async function acquireDebugger(tabId, consumer) {
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("A valid tab ID is required.");
  if (consumer == null) throw new Error("A debugger consumer ID is required.");

  const session = sessionFor(tabId);
  return enqueue(session, async () => {
    if (!session.attached) await attachDebugger(tabId, session);
    session.consumers.add(consumer);
    return snapshot(session);
  });
}

export async function releaseDebugger(tabId, consumer) {
  const session = sessions.get(tabId);
  if (!session) return { attached: false, protocolVersion: "", consumers: 0 };

  return enqueue(session, async () => {
    session.consumers.delete(consumer);
    if (session.attached && session.consumers.size === 0) {
      try {
        await chrome.debugger.detach({ tabId });
        session.attached = false;
        session.protocolVersion = "";
      } catch (error) {
        const message = String(error?.message || error);
        if (/not attached|no tab|target.*closed|does not exist/i.test(message)) {
          session.attached = false;
          session.protocolVersion = "";
        }
        // For transient failures, keep attached=true. A later consumer can reuse
        // the live session and its release will retry detaching instead of causing
        // a false "another debugger" conflict on the next attach attempt.
      }
    }
    return snapshot(session);
  });
}

export async function sendDebuggerCommand(tabId, method, params) {
  const session = sessions.get(tabId);
  if (!session?.attached) throw new Error("Debugger session is not attached for this tab.");
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export function getDebuggerSessionState(tabId) {
  const session = sessions.get(tabId);
  return session ? snapshot(session) : { attached: false, protocolVersion: "", consumers: 0 };
}

async function attachDebugger(tabId, session) {
  let lastError = null;
  for (const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS) {
    try {
      await chrome.debugger.attach({ tabId }, protocolVersion);
      session.attached = true;
      session.protocolVersion = protocolVersion;
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (/Another debugger|already attached|target is already being debugged/i.test(message)) {
        throw new Error("Tab is in use by DevTools or another debugger.");
      }
      if (!/protocol version|not supported|incompatible/i.test(message)) throw error;
    }
  }

  throw new Error(
    `Debugger could not be attached. Tried CDP version(s): ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}. ${String(lastError?.message || lastError || "")}`
  );
}

function snapshot(session) {
  return {
    attached: session.attached,
    protocolVersion: session.protocolVersion,
    consumers: session.consumers.size
  };
}

chrome.debugger.onDetach.addListener((source) => {
  if (!source.tabId) return;
  const session = sessions.get(source.tabId);
  if (!session) return;
  session.attached = false;
  session.protocolVersion = "";
  session.consumers.clear();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId);
  if (!session) return;
  session.consumers.clear();
  if (session.attached) {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  sessions.delete(tabId);
});
