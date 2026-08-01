import assert from "node:assert/strict";
import { buildExecutableExpression } from "../background/tools/script-parser.js";

async function evaluate(code, scope = {}) {
  const names = Object.keys(scope);
  const values = Object.values(scope);
  const expression = buildExecutableExpression(code);
  return Function(...names, `return ${expression};`)(...values);
}

assert.equal(await evaluate("40 + 2"), 42);
assert.equal(await evaluate("const x = 20; x + 22"), 42);
assert.deepEqual(await evaluate("{ answer: 42, nested: { ok: true } }"), {
  answer: 42,
  nested: { ok: true }
});
assert.equal(await evaluate("const x = 20; x + 22;;;; // trailing empties"), 42);
assert.equal(await evaluate("// leading comment\nconst x = 40; /* middle */ x + 2; // trailing"), 42);
assert.equal(await evaluate("const x = await Promise.resolve(40); x + 2"), 42);
assert.equal(await evaluate("`value:${21 * 2}`"), "value:42");
assert.equal(await evaluate("/a+/.test('aaa')"), true);
assert.equal(await evaluate("const text = 'const fake = 1;'; text"), "const fake = 1;");
assert.equal(await evaluate("const data = { nested: { value: 42 } }; data?.nested?.value"), 42);
assert.equal(await evaluate("#!/usr/bin/env node\n40 + 2"), 42);
assert.equal(await evaluate("let value = 1; value++;"), 1);
assert.equal(await evaluate("let value = 0; if (true) value = 42;"), undefined);
assert.equal(await evaluate("// comments only\n/* safe */"), undefined);
assert.equal(await evaluate(""), undefined);

await assert.rejects(() => evaluate("throw new Error('expected')"), /expected/);
assert.throws(() => buildExecutableExpression("const = 42"), /Unexpected token|Unexpected keyword|Assigning to rvalue/);
assert.throws(() => buildExecutableExpression("40 + 2 /*"), /Unterminated comment/);

globalThis.__parserSideEffect = 0;
buildExecutableExpression("globalThis.__parserSideEffect += 1");
assert.equal(globalThis.__parserSideEffect, 0, "parsing must never execute user code");
delete globalThis.__parserSideEffect;

const transformed = buildExecutableExpression("const x = 20; x + 22");
assert.match(transformed, /const x = 20;/);
assert.match(transformed, /return \(\s*x \+ 22\s*\)/);
assert.doesNotMatch(transformed, /return\s+const/);

console.log("Automatic JavaScript parser tests passed: expressions, programs, comments, object literals, top-level await, trailing semicolons, syntax errors, and hashbang normalization.");
