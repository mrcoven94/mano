// Fails when source under apps/ and packages/ builds a regex inside a function, or calls .test or .exec on a
// shared regex with the g or y flag, whose lastIndex would leak between calls. Tests, evals, scripts and probes
// are skipped, and so is code that runs once at module load, such as a .map at module scope.
// A pattern built from per-call data takes a marker with a reason, on its line or the line above:
//   // regex-ok: built from this person's name
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The root package has no dependencies of its own, so this borrows a workspace package's compiler.
const ts = createRequire(new URL("../apps/engine/package.json", import.meta.url))("typescript");

const SOURCE_FILE = /^(?:apps|packages)\/.+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const NOT_RUNTIME = /\.d\.ts$|\.(?:test|spec|sources)\.[^/]+$|\.config\.[^/]+$|\/(?:tests?|test-[^/]+|__tests__|evals?|scripts|probes?)\//;
const MARKER = /\/\/\s*regex-ok:(.*)$/;

// A callback handed to one of these at module scope runs while the module loads, not on every request.
const RUNS_CALLBACK_NOW = new Set([
  "map", "flatMap", "filter", "forEach", "reduce", "reduceRight", "some", "every",
  "find", "findIndex", "findLast", "findLastIndex", "sort", "toSorted", "from",
]);

export function inScope(path) {
  return SOURCE_FILE.test(path) && !NOT_RUNTIME.test(path);
}

function unwrap(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isRegexBuild(node) {
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  return (ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp";
}

// A regex with g or y, an array holding one, or a wrapper call around one, such as uw(/x/g).
function isStateful(node) {
  const value = unwrap(node);
  if (ts.isArrayLiteralExpression(value)) return value.elements.some(isStateful);
  if (!isRegexBuild(value)) return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.arguments.length > 0 && isStateful(value.arguments[0]);
  if (value.kind === ts.SyntaxKind.RegularExpressionLiteral) return /[gy]/.test(value.text.slice(value.text.lastIndexOf("/")));
  const flags = value.arguments?.[1];
  return flags !== undefined && ts.isStringLiteralLike(flags) && /[gy]/.test(flags.text);
}

// The array a name's values come from: `for (const re of LIST)` or `LIST.some((re) => ...)`.
function arrayBehind(name, node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isForOfStatement(current) && ts.isIdentifier(current.expression) && ts.isVariableDeclarationList(current.initializer)) {
      if (current.initializer.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) return current.expression.text;
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isCallExpression(current.parent) && ts.isPropertyAccessExpression(current.parent.expression)) {
      const target = current.parent.expression.expression;
      const first = current.parameters[0]?.name;
      if (ts.isIdentifier(target) && first && ts.isIdentifier(first) && first.text === name) return target.text;
    }
  }
  return null;
}

function runsOnceAtLoad(fn) {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  let outer = fn;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const call = outer.parent;
  if (!ts.isCallExpression(call)) return false;
  if (call.expression === outer) return true;
  return call.arguments.includes(outer) && ts.isPropertyAccessExpression(call.expression) && RUNS_CALLBACK_NOW.has(call.expression.name.text);
}

function runsPerCall(node) {
  for (let current = node; current.parent; current = current.parent) {
    if (ts.isFunctionLike(current) && !runsOnceAtLoad(current)) return true;
    const instanceField = ts.isPropertyDeclaration(current) && !current.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    if (instanceField) return true;
  }
  return false;
}

function parse(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function topLevelConsts(sourceFile) {
  return sourceFile.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]);
}

// Names of shared regexes with g or y that other files can import. Matching by name stays cheap and errs toward
// reporting: a clash with an unrelated export is rare and a marker settles it.
function statefulExports(sourceFile) {
  const local = new Set(topLevelConsts(sourceFile).filter((d) => d.initializer && isStateful(d.initializer)).map((d) => d.name.getText(sourceFile)));
  const exported = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of statement.declarationList.declarations) if (local.has(d.name.getText(sourceFile))) exported.add(d.name.getText(sourceFile));
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const e of statement.exportClause.elements) if (local.has((e.propertyName ?? e.name).text)) exported.add(e.name.text);
    }
  }
  return exported;
}

function sharedStatefulNames(sourceFile, exportedElsewhere) {
  const names = new Set();
  for (const d of topLevelConsts(sourceFile)) {
    if (d.initializer && isStateful(d.initializer)) names.add(d.name.getText(sourceFile));
  }
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const e of bindings.elements) if (exportedElsewhere.has((e.propertyName ?? e.name).text)) names.add(e.name.text);
  }
  return names;
}

export function scanFile(path, text, exportedElsewhere = new Set()) {
  const sourceFile = parse(path, text);
  const shared = sharedStatefulNames(sourceFile, exportedElsewhere);
  const found = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;

  const visit = (node) => {
    if (isRegexBuild(node) && runsPerCall(node)) {
      found.push({ line: lineOf(node), message: "regex built inside a function; move it to a module-level const" });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const method = node.expression.name.text;
      const name = node.expression.expression.text;
      const source = method === "test" || method === "exec" ? (shared.has(name) ? name : arrayBehind(name, node)) : null;
      if (source && shared.has(source)) {
        found.push({ line: lineOf(node), message: `.${method} on shared regex ${source} with the g or y flag leaks lastIndex between calls; drop the flag or use matchAll` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const lines = text.split("\n");
  const markers = new Map();
  lines.forEach((line, index) => {
    const reason = MARKER.exec(line)?.[1].trim();
    if (reason !== undefined) markers.set(index, { reason, used: false });
  });
  const issues = [];
  for (const issue of found) {
    const marker = markers.get(issue.line) ?? markers.get(issue.line - 1);
    if (marker) marker.used = true;
    else issues.push({ line: issue.line + 1, message: issue.message });
  }
  for (const [index, marker] of markers) {
    if (marker.reason === "") issues.push({ line: index + 1, message: "regex-ok marker needs a reason" });
    else if (!marker.used) issues.push({ line: index + 1, message: "regex-ok marker has nothing to allow; remove it" });
  }
  return issues.sort((a, b) => a.line - b.line);
}

export function scanFiles(files) {
  const exportedElsewhere = new Set();
  for (const { path, text } of files) for (const name of statefulExports(parse(path, text))) exportedElsewhere.add(name);
  return files.flatMap(({ path, text }) => scanFile(path, text, exportedElsewhere).map((issue) => ({ path, ...issue })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps", "packages"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => inScope(path) && existsSync(`${root}${path}`));
  const issues = scanFiles(paths.map((path) => ({ path, text: readFileSync(`${root}${path}`, "utf8") })));
  if (issues.length > 0) {
    console.error("Regexes that cost time or leak state on every call:");
    for (const { path, line, message } of issues) console.error(`  ${path}:${line} ${message}`);
    console.error("A pattern built from per-call data takes a marker with a reason: // regex-ok: <reason>");
    process.exit(1);
  }
  console.log(`regexes: ${paths.length} files, none built inside a function`);
}
