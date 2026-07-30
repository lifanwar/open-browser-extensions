(() => {
  const refToElement = new Map();
  let refCounter = 0;

  chrome.runtime.onMessage.addListener((message) => {
    try {
      return handle(message);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  function handle(message) {
    switch (message?.type) {
      case "READ_PAGE": return readPage();
      case "CLICK": return clickElement(message.ref);
      case "FILL": return fillElement(message.ref, message.text);
      case "SELECT": return selectOption(message.ref, message.value);
      case "PRESS_KEY": return pressKey(message.ref, message.key);
      case "SCROLL": return scroll(message);
      default: throw new Error(`Perintah halaman tidak dikenal: ${message?.type}`);
    }
  }

  function readPage() {
    refToElement.clear();
    refCounter = 0;
    const interactive = collectInteractive().slice(0, 180).map(describeElement);
    const text = visibleText(document.body).slice(0, 18_000);
    return {
      ok: true,
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      text,
      elements: interactive
    };
  }

  function collectInteractive() {
    const selector = [
      "a[href]", "button", "input", "textarea", "select", "summary",
      "[role='button']", "[role='link']", "[role='checkbox']", "[role='radio']",
      "[role='tab']", "[role='menuitem']", "[contenteditable='true']", "[tabindex]"
    ].join(",");
    return [...document.querySelectorAll(selector)].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (!isVisible(element)) return false;
      if (element.matches("[disabled], [aria-disabled='true']")) return false;
      const tabindex = element.getAttribute("tabindex");
      return tabindex !== "-1";
    });
  }

  function describeElement(element) {
    const ref = `e${++refCounter}`;
    refToElement.set(ref, element);
    const rect = element.getBoundingClientRect();
    return {
      ref,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || implicitRole(element),
      type: element.getAttribute("type") || undefined,
      text: accessibleName(element).slice(0, 240),
      value: safeValue(element),
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      selected: element instanceof HTMLSelectElement ? element.value : undefined,
      x: Math.round(rect.x),
      y: Math.round(rect.y)
    };
  }

  function clickElement(ref) {
    const element = getElement(ref);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    element.focus({ preventScroll: true });
    element.click();
    return { ok: true, clicked: ref, text: accessibleName(element).slice(0, 200) };
  }

  function fillElement(ref, text) {
    const element = getElement(ref);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
      throw new Error(`${ref} bukan input, textarea, atau contenteditable.`);
    }
    element.scrollIntoView({ block: "center", behavior: "instant" });
    element.focus();
    if (element.isContentEditable) {
      element.textContent = String(text);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(text) }));
    } else {
      setNativeValue(element, String(text));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true, filled: ref, length: String(text).length };
  }

  function selectOption(ref, value) {
    const element = getElement(ref);
    if (!(element instanceof HTMLSelectElement)) throw new Error(`${ref} bukan elemen select.`);
    const target = [...element.options].find((option) => option.value === value || option.text.trim() === value);
    if (!target) throw new Error(`Opsi tidak ditemukan: ${value}`);
    element.value = target.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: target.value, label: target.text };
  }

  function pressKey(ref, key) {
    const element = ref ? getElement(ref) : document.activeElement || document.body;
    if (element instanceof HTMLElement) element.focus();
    const init = { key: String(key), code: codeForKey(String(key)), bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent("keydown", init));
    element.dispatchEvent(new KeyboardEvent("keypress", init));
    element.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, key, ref: ref || null };
  }

  function scroll(message) {
    const direction = message.direction;
    const amount = Math.max(100, Math.min(5000, Number(message.amount || 700)));
    const target = message.ref ? getElement(message.ref) : window;
    if (direction === "top") target.scrollTo?.({ top: 0, behavior: "instant" });
    else if (direction === "bottom") target.scrollTo?.({ top: target === window ? document.documentElement.scrollHeight : target.scrollHeight, behavior: "instant" });
    else target.scrollBy?.({ top: direction === "up" ? -amount : amount, behavior: "instant" });
    return { ok: true, direction, amount, scrollY: window.scrollY };
  }

  function getElement(ref) {
    const element = refToElement.get(String(ref));
    if (!element || !element.isConnected) throw new Error(`Ref ${ref} sudah tidak valid. Jalankan read_page lagi.`);
    return element;
  }

  function visibleText(root) {
    if (!root) return "";
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,svg,canvas,template").forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function accessibleName(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element instanceof HTMLInputElement ? element.labels?.[0]?.innerText : "",
      element.innerText,
      element.getAttribute("placeholder"),
      element instanceof HTMLInputElement ? element.value : "",
      element.getAttribute("alt")
    ].find((value) => String(value || "").trim())?.trim() || "";
  }

  function safeValue(element) {
    if (element instanceof HTMLInputElement) {
      if (["password", "hidden"].includes(element.type)) return element.value ? "[HIDDEN]" : "";
      return element.value.slice(0, 200);
    }
    if (element instanceof HTMLTextAreaElement) return element.value.slice(0, 200);
    return undefined;
  }

  function implicitRole(element) {
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLAnchorElement) return "link";
    if (element instanceof HTMLSelectElement) return "combobox";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(element.type)) return "button";
      return "textbox";
    }
    return undefined;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function codeForKey(key) {
    if (key.length === 1) return `Key${key.toUpperCase()}`;
    return key;
  }

  // ponytail: semua fungsi sudah sync — sleep tidak lagi diperlukan.
  // Jika suatu saat diperlukan delay async, tambahkan await sleep(n) di
  // handle() saja dengan return true kembali.
})();
