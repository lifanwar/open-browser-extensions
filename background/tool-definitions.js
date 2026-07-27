import { WEB_SEARCH_TOOL_DEFINITION } from "./tools/search/search-tool.js";

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  }
});

export const TOOL_DEFINITIONS = [
  fn("read_page", "Read the current target page and return visible text plus interactive elements with stable refs."),
  fn("click", "Click an interactive element from read_page using its ref.", {
    ref: { type: "string", description: "Element ref such as e12." }
  }, ["ref"]),
  fn("fill", "Replace the value of a text input or textarea identified by ref.", {
    ref: { type: "string" },
    text: { type: "string" }
  }, ["ref", "text"]),
  fn("select_option", "Choose an option in a select element.", {
    ref: { type: "string" },
    value: { type: "string", description: "Option value or visible label." }
  }, ["ref", "value"]),
  fn("press_key", "Press a keyboard key on an element or on the document.", {
    key: { type: "string", description: "Keyboard key, for example Enter, Escape, ArrowDown." },
    ref: { type: "string", description: "Optional element ref to focus first." }
  }, ["key"]),
  fn("scroll_page", "Scroll the current page or an element.", {
    direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
    amount: { type: "integer", description: "Pixels for up/down; defaults to 700." },
    ref: { type: "string", description: "Optional scrollable element ref." }
  }, ["direction"]),
  fn("wait", "Wait briefly for a page update.", {
    milliseconds: { type: "integer", minimum: 100, maximum: 10000 }
  }, ["milliseconds"]),
  fn("navigate", "Navigate the target tab to an http or https URL. When Web search tool is enabled, use this only for genuine browser interaction and set interaction_required to true.", {
    url: { type: "string" },
    interaction_required: {
      type: "boolean",
      description: "Set true only when the page must be opened for clicks, forms, login, visual inspection, or another browser-only interaction."
    }
  }, ["url"]),
  fn("list_tabs", "List browser tabs in the current window."),
  fn("switch_tab", "Switch the agent target to another tab returned by list_tabs.", {
    tab_id: { type: "integer" }
  }, ["tab_id"]),
  fn("network_start", "Start DevTools Network capture on the target tab. read_page may already start it automatically."),
  fn("network_get", "Get recently captured Network requests. Sensitive values are revealed only when enabled by the user in Settings and only for the current page host.", {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    url_filter: { type: "string" },
    method_filter: { type: "string" },
    resource_type: { type: "string" },
    include_headers: { type: "boolean" },
    include_bodies: { type: "boolean" }
  }),
  fn("network_clear", "Clear captured Network entries for the target tab."),
  fn("network_stop", "Stop Network capture and detach the debugger from the target tab."),
  fn("cookies_list", "List all cookies available to the current page, including HttpOnly and auth cookies. Values can be exported as JSON.", {
    include_values: { type: "boolean", description: "Include cookie values. Defaults to true; set to false to redact values." }
  }),
  fn("cookies_set", "Create or update one cookie for the current page host, including HttpOnly and auth cookies. Requires cookie writes enabled in Settings.", {
    cookie: {
      type: "object",
      description: "Cookie object for the current page host.",
      properties: {
        name: { type: "string" },
        value: { type: "string" },
        domain: { type: "string" },
        path: { type: "string" },
        secure: { type: "boolean" },
        same_site: { type: "string", enum: ["unspecified", "lax", "strict", "no_restriction"] },
        expiration_date: { type: "number" }
      },
      required: ["name", "value"],
      additionalProperties: false
    }
  }, ["cookie"]),
  fn("cookies_import", "Paste/import a JSON array of cookies into the current page host. HttpOnly and auth cookies are accepted; domain validation is not enforced. Requires cookie writes enabled in Settings.", {
    cookies_json: { type: "string", description: "JSON array of cookie objects, typically copied from cookies_list export_json." }
  }, ["cookies_json"]),
  fn("cookies_delete", "Delete a cookie from the current page by name, optionally narrowed by path and domain. Requires cookie writes enabled in Settings.", {
    name: { type: "string" },
    path: { type: "string" },
    domain: { type: "string" }
  }, ["name"]),
  fn("cookies_delete_all", "Delete all cookies applicable to the current page. Requires cookie writes enabled in Settings.")
];

const COOKIE_WRITE_TOOL_NAMES = new Set([
  "cookies_set",
  "cookies_import",
  "cookies_delete",
  "cookies_delete_all"
]);

/**
 * Advertise only tools that are enabled by the current settings.
 * Search stays completely hidden from the model while disabled.
 */
export function getToolDefinitions(settings = {}) {
  const tools = settings.allowCookieWrites
    ? [...TOOL_DEFINITIONS]
    : TOOL_DEFINITIONS.filter((tool) => !COOKIE_WRITE_TOOL_NAMES.has(tool.function.name));

  if (settings.enableSearchTool) {
    tools.push(WEB_SEARCH_TOOL_DEFINITION);
  }

  return tools;
}
