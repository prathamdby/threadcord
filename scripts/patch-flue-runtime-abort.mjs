#!/usr/bin/env node
/**
 * Patches @flue/runtime so NodeAgentCoordinator exposes abortInstance() and
 * registers with Threadcord on startup. Re-run after npm install.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@flue/runtime",
  "dist",
);
const target = join(runtimeRoot, "internal.mjs");

const MARKER = "abortInstance(instanceId, reason)";
const RETURN_NEEDLE = "\treturn {\n\t\tasync reconcileSubmissions() {";
const RETURN_REPLACEMENT = `\tconst coordinator = {
\t\tasync reconcileSubmissions() {`;

const SHUTDOWN_NEEDLE = `\t\tasync shutdown(timeoutMs = 3e4) {`;
const SHUTDOWN_REPLACEMENT = `\t\tasync abortInstance(instanceId, reason) {
\t\t\tconst abortReason = reason ?? new DOMException("Aborted by operator via thread command.", "AbortError");
\t\t\tlet aborted = 0;
\t\t\tfor (const [submissionId, { abort }] of activeSubmissions) {
\t\t\t\tconst sub = await submissions.getSubmission(submissionId);
\t\t\t\tif (sub?.input?.id !== instanceId) continue;
\t\t\t\tabort.abort(abortReason);
\t\t\t\taborted += 1;
\t\t\t}
\t\t\treturn aborted;
\t\t},
\t\tasync shutdown(timeoutMs = 3e4) {`;

const CLOSE_NEEDLE = "\t\t}\n\t};\n}\n//#endregion\n//#region src/node/run-store.ts";
const CLOSE_REPLACEMENT = `\t\t}
\t};
\tglobalThis.__threadcordRegisterFlueCoordinator?.(coordinator);
\treturn coordinator;
}
//#endregion
//#region src/node/run-store.ts`;

let source = readFileSync(target, "utf8");
if (source.includes(MARKER)) {
  process.exit(0);
}
if (
  !source.includes(RETURN_NEEDLE) ||
  !source.includes(SHUTDOWN_NEEDLE) ||
  !source.includes(CLOSE_NEEDLE)
) {
  console.error(
    "[patch-flue-runtime-abort] Could not find all coordinator patch anchors; @flue/runtime version may have changed.",
  );
  process.exit(1);
}
source = source.replace(RETURN_NEEDLE, RETURN_REPLACEMENT);
source = source.replace(SHUTDOWN_NEEDLE, SHUTDOWN_REPLACEMENT);
source = source.replace(CLOSE_NEEDLE, CLOSE_REPLACEMENT);
if (source.includes(RETURN_NEEDLE)) {
  console.error(
    "[patch-flue-runtime-abort] Coordinator return anchor still present after patch.",
  );
  process.exit(1);
}
writeFileSync(target, source);
console.log("[patch-flue-runtime-abort] Patched @flue/runtime NodeAgentCoordinator.abortInstance");