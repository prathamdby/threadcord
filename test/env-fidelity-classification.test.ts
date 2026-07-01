import { describe, expect, it } from "vitest";
import { classifyCommandFailure } from "./support/env-fidelity-helpers.js";

/**
 * Unit tests for the environment-fidelity classification helper.
 *
 * These run in the default `npm test` suite (no AgentOS required) and prove
 * VAL-FOUND-025: native-dependency failures are classified as environment
 * blockers with the correct `agent_environment_issues` shape.
 */

describe("Environment issue classification", () => {
  it("classifies a missing internal npm module as missing_package", () => {
    const issue = classifyCommandFailure("npm install", {
      exitCode: 1,
      stdout: "",
      stderr:
        "Error: Cannot find module '/__secure_exec/node-runtime/npm/lib/utils/display.js'",
    });

    expect(issue.kind).toBe("missing_package");
    expect(issue.severity).toBe("error");
    expect(issue.packageName).toContain("display.js");
    expect(issue.message).toContain("npm install");
    expect(issue.suggestedAction).toContain("fallback");
    expect(issue.createdAt).toBeInstanceOf(Date);
  });

  it("classifies a missing command as missing_package", () => {
    const issue = classifyCommandFailure("docker --version", {
      exitCode: 127,
      stdout: "",
      stderr: "docker: command not found",
    });

    expect(issue.kind).toBe("missing_package");
    expect(issue.packageName).toBe("docker");
  });

  it("classifies an unsupported architecture as unsupported_arch", () => {
    const issue = classifyCommandFailure("./native-bin", {
      exitCode: 1,
      stdout: "",
      stderr: "fatal: unsupported architecture: arm64 required",
    });

    expect(issue.kind).toBe("unsupported_arch");
    expect(issue.suggestedAction).toContain("linux/arm64");
  });

  it("classifies a network failure as blocked_network", () => {
    const issue = classifyCommandFailure("npm install", {
      exitCode: 1,
      stdout: "",
      stderr: "npm ERR! code ECONNREFUSED\nnpm ERR! errno ECONNREFUSED",
    });

    expect(issue.kind).toBe("blocked_network");
    expect(issue.suggestedAction).toContain("egress");
  });

  it("defaults unknown native failures to native_dependency_failure", () => {
    const issue = classifyCommandFailure("node-gyp rebuild", {
      exitCode: 1,
      stdout: "",
      stderr: "g++: error: unrecognized command-line option",
    });

    expect(issue.kind).toBe("native_dependency_failure");
    expect(issue.suggestedAction).toContain("toolchain");
  });

  it("produces an agent_environment_issues-shaped record", () => {
    const issue = classifyCommandFailure(
      "npm install",
      {
        exitCode: 1,
        stdout: "",
        stderr: "Cannot find module 'foo'",
      },
      {
        taskId: "task-1",
        setupId: "setup-1",
      },
    );

    expect(issue.id).toMatch(/^env-issue-/);
    expect(issue.taskId).toBe("task-1");
    expect(issue.setupId).toBe("setup-1");
    expect(issue.severity).toBe("error");
    expect(issue.kind).toBe("missing_package");
    expect(issue.message).toBeTruthy();
    expect(issue.createdAt).toBeInstanceOf(Date);
  });
});
