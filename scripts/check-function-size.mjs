#!/usr/bin/env node
/**
 * Function-size ratchet — mega-functions may only shrink.
 *
 * Parses every non-test TypeScript file under src/ with swc and measures
 * each named function (declaration, method, or function-valued `const`):
 * line count and a cyclomatic-complexity estimate (one per branch point:
 * if / loop / case / catch / ternary / `&&` `||` `??`).
 *
 * A function is "oversize" when it exceeds LINE_LIMIT lines or CX_LIMIT
 * branch points. The committed BASELINE lists the oversize functions the
 * tree currently has. The gate fails when:
 *
 *   1. a function not in the baseline is oversize (new mega-function), or
 *   2. a baseline function grew past its recorded size.
 *
 * When a function drops under the limits, the script says so and the
 * entry should be deleted from BASELINE in the same PR — that's the
 * ratchet clicking one tooth tighter. Deleting the gate requires an empty
 * baseline first.
 *
 * `--update` rewrites the baseline from the current tree (use it only in
 * a PR that also explains why a function had to grow).
 *
 * See docs/cleanup-plan.md for why these limits and which functions are
 * on the worklist.
 */
import { parseSync } from "@swc/core";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE_PATH = join(ROOT, "scripts", "function-size-baseline.json");
const LINE_LIMIT = 150;
const CX_LIMIT = 25;

const BRANCHES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchCase",
  "ConditionalExpression",
  "CatchClause",
]);
const LOGICAL = new Set(["&&", "||", "??"]);

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      yield* walkFiles(path);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      yield path;
    }
  }
}

/** Depth-first walk over every AST node; `cb(node, parent)`. */
function walk(node, cb, parent = null) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, cb, parent);
    return;
  }
  if (typeof node.type === "string") cb(node, parent);
  for (const key in node) {
    if (key === "span" || key === "type") continue;
    const value = node[key];
    if (value && typeof value === "object")
      walk(value, cb, node.type ? node : parent);
  }
}

function complexity(body) {
  let cx = 1;
  walk(body, (n) => {
    if (BRANCHES.has(n.type)) cx++;
    else if (n.type === "BinaryExpression" && LOGICAL.has(n.operator)) cx++;
  });
  return cx;
}

function functionName(node, parent) {
  if (node.type === "FunctionDeclaration")
    return node.identifier?.value ?? null;
  if (node.type === "ClassMethod" || node.type === "PrivateMethod") {
    return "." + (node.key?.value ?? node.key?.id?.value ?? "?");
  }
  if (node.type === "MethodProperty") return "." + (node.key?.value ?? "?");
  if (
    (node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") &&
    parent
  ) {
    if (parent.type === "VariableDeclarator") return parent.id?.value ?? null;
    if (parent.type === "KeyValueProperty")
      return "." + (parent.key?.value ?? "?");
    if (parent.type === "ClassProperty")
      return "." + (parent.key?.value ?? "?");
  }
  return null;
}

function measureFile(path) {
  const source = readFileSync(path, "utf8");
  // swc spans are offsets into a process-global source map, and the
  // module's own span starts at its first token — after any header
  // comment — so it can't anchor file offsets. A leading `;` puts a token
  // at byte 0: its start is the file's base, and every offset is shifted
  // by exactly that one byte. (A hashbang must stay first, so it becomes
  // a same-length line comment.)
  const text = source.startsWith("#!") ? "//" + source.slice(2) : source;
  const module = parseSync(";" + text, {
    syntax: "typescript",
    target: "es2022",
  });
  const base = module.span.start + 1;
  // swc offsets count UTF-8 bytes, so index lines by byte too — a char
  // index drifts by every multibyte character (—, →, emoji) above.
  const bytes = Buffer.from(source, "utf8");
  const lineStarts = [0];
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 10) lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const rows = [];
  walk(module, (node, parent) => {
    const fn =
      node.type === "ClassMethod" ||
      node.type === "PrivateMethod" ||
      node.type === "MethodProperty"
        ? (node.function ?? node)
        : node;
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassMethod" ||
      node.type === "PrivateMethod" ||
      node.type === "MethodProperty";
    if (!isFn || !fn.body || fn.body.type !== "FunctionBody") return;
    const name = functionName(node, parent);
    if (!name) return;
    const start = lineOf(node.span.start - base);
    const end = lineOf(node.span.end - base);
    rows.push({
      file: relative(ROOT, path),
      name,
      lines: end - start + 1,
      cx: complexity(fn.body),
    });
  });
  // Two anonymous `.handler` methods in one file would share a key —
  // number repeats in source order so each baseline entry stays stable.
  const seen = new Map();
  for (const row of rows) {
    const n = (seen.get(row.name) ?? 0) + 1;
    seen.set(row.name, n);
    if (n > 1) row.name = `${row.name}#${n}`;
  }
  return rows;
}

const rows = [];
for (const file of walkFiles(join(ROOT, "src")))
  rows.push(...measureFile(file));
const oversize = rows
  .filter((r) => r.lines > LINE_LIMIT || r.cx > CX_LIMIT)
  .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
const key = (r) => `${r.file} ${r.name}`;

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(oversize, null, 2) + "\n");
  console.log(`Baseline rewritten: ${oversize.length} oversize functions.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const baselineByKey = new Map(baseline.map((r) => [key(r), r]));
const currentByKey = new Map(rows.map((r) => [key(r), r]));
let failed = false;

for (const r of oversize) {
  const b = baselineByKey.get(key(r));
  if (!b) {
    failed = true;
    console.error(
      `NEW  ${r.lines}L cx${r.cx}  ${key(r)} — over ${LINE_LIMIT} lines or complexity ${CX_LIMIT}; split it.`,
    );
  } else if (r.lines > b.lines || r.cx > b.cx) {
    failed = true;
    console.error(
      `GREW ${b.lines}L cx${b.cx} → ${r.lines}L cx${r.cx}  ${key(r)} — oversize functions may only shrink.`,
    );
  }
}
for (const b of baseline) {
  const r = currentByKey.get(key(b));
  if (!r || (r.lines <= LINE_LIMIT && r.cx <= CX_LIMIT)) {
    console.log(
      `DONE ${key(b)} is under the limits (or gone) — remove it from ${relative(ROOT, BASELINE_PATH)}.`,
    );
  } else if (r.lines < b.lines || r.cx < b.cx) {
    console.log(
      `SHRANK ${b.lines}L cx${b.cx} → ${r.lines}L cx${r.cx}  ${key(b)} — lower its baseline entry.`,
    );
  }
}

console.log(
  `${rows.length} functions measured; ${oversize.length} over ${LINE_LIMIT} lines / cx ${CX_LIMIT} (baseline ${baseline.length}).`,
);
if (failed) process.exit(1);
