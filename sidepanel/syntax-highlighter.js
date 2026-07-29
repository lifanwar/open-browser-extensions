/*
 * Dependency-free syntax highlighting for the side panel.
 * Clean source, no runtime package, no eval, and CSP-safe generated markup.
 */
(function attachSyntaxHighlight(globalScope) {
  "use strict";

  const LANGUAGE_ALIASES = Object.freeze({
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    shellscript: "shell",
    yml: "yaml",
    html: "markup",
    htm: "markup",
    xml: "markup",
    svg: "markup",
    md: "markdown",
    cs: "csharp",
    "c#": "csharp",
    cpp: "cpp",
    "c++": "cpp",
    kt: "kotlin",
    kts: "kotlin",
    rs: "rust",
    golang: "go",
    plaintext: "text",
    txt: "text",
    console: "text"
  });

  const LANGUAGE_LABELS = Object.freeze({
    javascript: "JavaScript",
    typescript: "TypeScript",
    json: "JSON",
    markup: "HTML",
    css: "CSS",
    scss: "SCSS",
    less: "Less",
    python: "Python",
    ruby: "Ruby",
    php: "PHP",
    shell: "Shell",
    sql: "SQL",
    java: "Java",
    kotlin: "Kotlin",
    c: "C",
    cpp: "C++",
    csharp: "C#",
    go: "Go",
    rust: "Rust",
    swift: "Swift",
    dart: "Dart",
    yaml: "YAML",
    markdown: "Markdown",
    text: "Plain text"
  });

  const KEYWORDS = Object.freeze({
    javascript: words("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield"),
    typescript: words("abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get global if implements import in infer instanceof interface is keyof let module namespace never new null number object of override private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield"),
    python: words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case"),
    ruby: words("alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield"),
    php: words("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield"),
    shell: words("case do done elif else esac fi for function if in select then time until while coproc"),
    sql: words("add all alter and any as asc backup between by case check column constraint create database default delete desc distinct drop exec exists foreign from full group having in index inner insert into is join key left like limit not null on or order outer primary procedure right rownum select set table top truncate union unique update values view where with returning begin commit rollback grant revoke"),
    java: words("abstract assert boolean break byte case catch char class const continue default do double else enum exports extends final finally float for goto if implements import instanceof int interface long module native new non-sealed null open opens package permits private protected provides public record requires return sealed short static strictfp super switch synchronized this throw throws to transient transitive try uses var void volatile while with yield"),
    kotlin: words("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg"),
    c: words("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local"),
    cpp: words("alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reflexpr register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch synchronized template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq"),
    csharp: words("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while async await dynamic get global partial remove set value var when where yield"),
    go: words("break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var"),
    rust: words("as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try"),
    swift: words("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self Self throw throws true try async await actor some any"),
    dart: words("abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield"),
    yaml: words("true false null yes no on off")
  });

  const TYPES = words("Array ArrayBuffer BigInt Boolean Date Error Function Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet HTMLElement Document Element Event JSON console window document globalThis process Buffer List Dict Tuple Optional Result StringBuilder Integer Long Double Float Byte Short BigDecimal BigInteger UUID URL HttpClient Request Response Exception RuntimeException Context View Model"),
    CONSTANTS = words("true false null undefined NaN Infinity None nil self this super"),
    C_LIKE = new Set(["javascript", "typescript", "java", "kotlin", "c", "cpp", "csharp", "go", "rust", "swift", "dart", "php"]),
    HASH_COMMENT = new Set(["python", "ruby", "shell", "yaml"]),
    DASH_COMMENT = new Set(["sql"]);

  function words(value) {
    return new Set(String(value).split(/\s+/).filter(Boolean));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeLanguage(value) {
    const raw = String(value || "text").trim().toLowerCase().replace(/^language-/, "");
    const clean = raw.replace(/[^a-z0-9+#._-]/g, "").slice(0, 32) || "text";
    return LANGUAGE_ALIASES[clean] || clean;
  }

  function languageLabel(language) {
    if (LANGUAGE_LABELS[language]) return LANGUAGE_LABELS[language];
    return language === "text" ? "Plain text" : language.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function token(type, value) {
    return `<span class="tok-${type}">${escapeHtml(value)}</span>`;
  }

  function readQuoted(code, start, quote) {
    const triple = code.slice(start, start + 3) === quote.repeat(3);
    const delimiter = triple ? quote.repeat(3) : quote;
    let index = start + delimiter.length;

    while (index < code.length) {
      if (code[index] === "\\") {
        index += 2;
        continue;
      }
      if (code.slice(index, index + delimiter.length) === delimiter) {
        return index + delimiter.length;
      }
      index += 1;
    }
    return code.length;
  }

  function readTemplate(code, start) {
    let index = start + 1;
    while (index < code.length) {
      if (code[index] === "\\") {
        index += 2;
        continue;
      }
      if (code[index] === "`") return index + 1;
      index += 1;
    }
    return code.length;
  }

  function previousNonSpace(code, index) {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
    return cursor >= 0 ? code[cursor] : "";
  }

  function nextNonSpace(code, index) {
    let cursor = index;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
    return cursor < code.length ? code[cursor] : "";
  }

  function isLineCommentStart(code, index, language) {
    if (C_LIKE.has(language) && code.slice(index, index + 2) === "//") return 2;
    if (HASH_COMMENT.has(language) && code[index] === "#") return 1;
    if (DASH_COMMENT.has(language) && code.slice(index, index + 2) === "--") return 2;
    return 0;
  }

  function highlightGeneric(code, language) {
    const keywordSet = KEYWORDS[language] || new Set();
    let output = "";
    let plain = "";
    let index = 0;

    const flushPlain = () => {
      if (!plain) return;
      output += escapeHtml(plain);
      plain = "";
    };

    while (index < code.length) {
      const lineCommentLength = isLineCommentStart(code, index, language);
      if (lineCommentLength) {
        flushPlain();
        const end = code.indexOf("\n", index);
        const stop = end === -1 ? code.length : end;
        output += token("comment", code.slice(index, stop));
        index = stop;
        continue;
      }

      if (C_LIKE.has(language) && code.slice(index, index + 2) === "/*") {
        flushPlain();
        const end = code.indexOf("*/", index + 2);
        const stop = end === -1 ? code.length : end + 2;
        output += token("comment", code.slice(index, stop));
        index = stop;
        continue;
      }

      const character = code[index];
      if (character === "\"" || character === "'") {
        flushPlain();
        const stop = readQuoted(code, index, character);
        output += token("string", code.slice(index, stop));
        index = stop;
        continue;
      }

      if (character === "`" && (language === "javascript" || language === "typescript")) {
        flushPlain();
        const stop = readTemplate(code, index);
        output += token("string", code.slice(index, stop));
        index = stop;
        continue;
      }

      const number = code.slice(index).match(/^(?:0[xob][0-9a-f_]+|\d(?:[\d_]*\.?[\d_]*)(?:e[+-]?\d+)?)/i);
      if (number) {
        flushPlain();
        output += token("number", number[0]);
        index += number[0].length;
        continue;
      }

      const variable = (language === "php" || language === "shell")
        ? code.slice(index).match(/^\$[A-Za-z_][\w]*/)
        : null;
      if (variable) {
        flushPlain();
        output += token("variable", variable[0]);
        index += variable[0].length;
        continue;
      }

      const identifier = code.slice(index).match(/^[A-Za-z_$][\w$-]*/);
      if (identifier) {
        flushPlain();
        const value = identifier[0];
        const lower = value.toLowerCase();
        const before = previousNonSpace(code, index);
        const after = nextNonSpace(code, index + value.length);
        let type = "plain";

        if (keywordSet.has(value) || keywordSet.has(lower)) type = "keyword";
        else if (CONSTANTS.has(value) || CONSTANTS.has(lower)) type = "constant";
        else if (TYPES.has(value) || /^[A-Z][A-Za-z0-9_$]*$/.test(value)) type = "type";
        else if (after === "(") type = "function";
        else if (before === "." || after === ":") type = "property";

        output += type === "plain" ? escapeHtml(value) : token(type, value);
        index += value.length;
        continue;
      }

      const operator = code.slice(index).match(/^(?:===|!==|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\+=|-=|\*=|\/=|%=|\*\*|<<|>>>?|::|:=|->|[+\-*\/%=&|!<>?:~^])/);
      if (operator) {
        flushPlain();
        output += token("operator", operator[0]);
        index += operator[0].length;
        continue;
      }

      if (/[{}()[\],.;]/.test(character)) {
        flushPlain();
        output += token("punctuation", character);
        index += 1;
        continue;
      }

      plain += character;
      index += 1;
    }

    flushPlain();
    return output;
  }

  function highlightTag(tagSource) {
    const match = tagSource.match(/^(<\/?)([A-Za-z][\w:-]*)([\s\S]*?)(\/?>)$/);
    if (!match) return token("tag", tagSource);

    const [, open, name, body, close] = match;
    let result = token("punctuation", open) + token("tag", name);
    let cursor = 0;
    const attributePattern = /([:\w-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/g;
    let attribute;

    while ((attribute = attributePattern.exec(body))) {
      result += escapeHtml(body.slice(cursor, attribute.index));
      result += token("attr", attribute[1]);
      result += token("operator", attribute[2]);
      result += token("string", attribute[3]);
      cursor = attribute.index + attribute[0].length;
    }

    result += escapeHtml(body.slice(cursor));
    result += token("punctuation", close);
    return result;
  }

  function highlightMarkup(code) {
    let output = "";
    let cursor = 0;
    const markupPattern = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[A-Za-z][^>]*>/gi;
    let match;

    while ((match = markupPattern.exec(code))) {
      output += escapeHtml(code.slice(cursor, match.index));
      const source = match[0];
      if (source.startsWith("<!--")) output += token("comment", source);
      else if (/^<!doctype/i.test(source)) output += token("keyword", source);
      else output += highlightTag(source);
      cursor = match.index + source.length;
    }

    output += escapeHtml(code.slice(cursor));
    return output;
  }

  function highlightMarkdown(code) {
    const lines = code.split("\n");
    return lines.map((line) => {
      if (/^\s*#{1,6}\s/.test(line)) return token("keyword", line);
      if (/^\s*>/.test(line)) return token("comment", line);
      if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) return token("punctuation", line);
      return escapeHtml(line)
        .replace(/(&quot;|&#039;)(.*?)(\1)/g, '<span class="tok-string">$1$2$3</span>')
        .replace(/`([^`]+)`/g, '<span class="tok-string">`$1`</span>')
        .replace(/(\*\*|__)(.+?)(\1)/g, '<span class="tok-keyword">$1$2$3</span>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="tok-property">[$1]</span><span class="tok-punctuation">(</span><span class="tok-string">$2</span><span class="tok-punctuation">)</span>');
    }).join("\n");
  }

  function highlight(code, requestedLanguage) {
    const language = normalizeLanguage(requestedLanguage);
    const source = String(code || "").replace(/\r\n?/g, "\n");
    if (language === "text") return escapeHtml(source);
    if (language === "markup") return highlightMarkup(source);
    if (language === "markdown") return highlightMarkdown(source);
    return highlightGeneric(source, language);
  }

  function copyIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg>';
  }

  function renderCodeBlock(code, requestedLanguage) {
    const language = normalizeLanguage(requestedLanguage);
    const label = languageLabel(language);
    const safeLanguage = escapeHtml(language);
    const safeLabel = escapeHtml(label);
    const normalizedCode = String(code || "").replace(/\r\n?/g, "\n").replace(/^\n/, "").replace(/\n$/, "");

    return `<div class="code-block-wrapper" data-language="${safeLanguage}">`
      + '<div class="code-block-toolbar">'
      + `<span class="code-block-language">${safeLabel}</span>`
      + `<button class="copy-btn" type="button" aria-label="Copy ${safeLabel} code" title="Copy code">${copyIcon()}<span>Copy</span></button>`
      + "</div>"
      + `<pre tabindex="0"><code class="syntax-code language-${safeLanguage}" data-language="${safeLanguage}">${highlight(normalizedCode, language)}</code></pre>`
      + "</div>";
  }

  globalScope.SyntaxHighlight = Object.freeze({
    escapeHtml,
    highlight,
    languageLabel,
    normalizeLanguage,
    renderCodeBlock
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
