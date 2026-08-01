import { parse, parseExpressionAt } from "../../vendor/acorn/acorn.mjs";

const PARSE_OPTIONS = Object.freeze({
  ecmaVersion: "latest",
  sourceType: "script",
  allowAwaitOutsideFunction: true,
  allowHashBang: true
});

export function buildExecutableExpression(input) {
  const original = String(input ?? "");
  const code = original.startsWith("#!") ? `//${original.slice(2)}` : original;
  if (!code.trim()) return "(async()=>{\n})()";

  const expression = parseWholeExpression(code);
  if (expression) {
    return `(async()=>{\nreturn (\n${code.slice(expression.start, expression.end)}\n);\n})()`;
  }

  const program = parse(code, PARSE_OPTIONS);
  const last = [...program.body].reverse().find((node) => node.type !== "EmptyStatement");
  if (!last || last.type !== "ExpressionStatement") {
    return `(async()=>{\n${code}\n})()`;
  }

  const before = code.slice(0, last.start);
  const expressionSource = code.slice(last.expression.start, last.expression.end);
  const after = code.slice(last.end);
  return `(async()=>{\n${before}return (\n${expressionSource}\n);${after}\n})()`;
}

function parseWholeExpression(code) {
  const start = skipTrivia(code, 0);
  if (start < 0 || start >= code.length) return null;

  try {
    const expression = parseExpressionAt(code, start, PARSE_OPTIONS);
    const trailing = skipTrailingTriviaAndSemicolons(code, expression.end);
    return trailing === code.length ? expression : null;
  } catch {
    return null;
  }
}

function skipTrivia(code, start) {
  let index = start;
  while (index < code.length) {
    const char = code[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && code[index + 1] === "/") {
      index += 2;
      while (index < code.length && code[index] !== "\n" && code[index] !== "\r") index += 1;
      continue;
    }
    if (char === "/" && code[index + 1] === "*") {
      const end = code.indexOf("*/", index + 2);
      if (end === -1) return -1;
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function skipTrailingTriviaAndSemicolons(code, start) {
  let index = start;
  while (index < code.length) {
    const next = skipTrivia(code, index);
    if (next < 0) return -1;
    if (next !== index) {
      index = next;
      continue;
    }
    if (code[index] === ";") {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}
