#!/usr/bin/env node
/**
 * Patches @flue/runtime createCustomTools so AgentTool.prepareArguments is
 * forwarded from custom tool definitions. Re-run after npm install.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@flue/runtime",
  "dist",
);

const MARKER = "prepareArguments: typeof toolDef.prepareArguments";
const CREATE_CUSTOM_TOOLS = "createCustomTools(tools, builtinTools)";
const PARAMETERS_NEEDLE = "parameters: toolDef.parameters,\n";
const EXECUTE_AFTER = "async execute(_toolCallId";
const INSERT =
  "prepareArguments: typeof toolDef.prepareArguments === \"function\" ? toolDef.prepareArguments : undefined,\n";

function findTarget() {
  const files = readdirSync(runtimeRoot).filter((f) => f.endsWith(".mjs"));
  for (const file of files) {
    const path = join(runtimeRoot, file);
    const source = readFileSync(path, "utf8");
    if (source.includes(CREATE_CUSTOM_TOOLS)) {
      return { path, source };
    }
  }
  return null;
}

const found = findTarget();
if (!found) {
  console.error(
    "[patch-flue-prepare-arguments] Could not find createCustomTools in @flue/runtime/dist.",
  );
  process.exit(1);
}

let { path: target, source } = found;
if (source.includes(MARKER)) {
  process.exit(0);
}

// Locate the createCustomTools return object: parameters then async execute
const createIdx = source.indexOf(CREATE_CUSTOM_TOOLS);
if (createIdx < 0) {
  console.error(
    "[patch-flue-prepare-arguments] createCustomTools symbol missing after locate.",
  );
  process.exit(1);
}

const region = source.slice(createIdx);
const paramsIdx = region.indexOf(PARAMETERS_NEEDLE);
if (paramsIdx < 0) {
  console.error(
    "[patch-flue-prepare-arguments] Could not find parameters: toolDef.parameters anchor.",
  );
  process.exit(1);
}

const afterParams = region.slice(paramsIdx + PARAMETERS_NEEDLE.length);
// Match indentation of the next line (async execute)
const tabIndent = afterParams.match(new RegExp(`^(\\t*)${escapeRegExp(EXECUTE_AFTER)}`));
const spaceIndent = afterParams.match(new RegExp(`^(\\s*)${escapeRegExp(EXECUTE_AFTER)}`));
if (!tabIndent) {
  if (!spaceIndent || !afterParams.trimStart().startsWith(EXECUTE_AFTER)) {
    console.error(
      `[patch-flue-prepare-arguments] parameters anchor not followed by ${EXECUTE_AFTER}.`,
    );
    process.exit(1);
  }
}

const indent = (tabIndent ?? spaceIndent)[1];
const absoluteParamsEnd = createIdx + paramsIdx + PARAMETERS_NEEDLE.length;
const insertion = `${indent}${INSERT}`;
// Insert right after parameters line
source =
  source.slice(0, absoluteParamsEnd) + insertion + source.slice(absoluteParamsEnd);

if (!source.includes(MARKER)) {
  console.error(
    "[patch-flue-prepare-arguments] Marker missing after patch write preparation.",
  );
  process.exit(1);
}

writeFileSync(target, source);
console.log(
  `[patch-flue-prepare-arguments] Patched prepareArguments forward in ${target}`,
);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
