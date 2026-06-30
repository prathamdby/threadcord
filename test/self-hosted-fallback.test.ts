import { describe, expect, it } from "vitest";
import {
  HostCommandFallbackExecutor,
  DockerContainerFallbackExecutor,
  createDockerCliClient,
  type DockerContainerSpec,
  type DockerClient,
  type FallbackCommandResult,
} from "../src/agentturn/fallback.js";

describe("HostCommandFallbackExecutor", () => {
  it("rejects a command that is not on the allowlist", async () => {
    const executor = new HostCommandFallbackExecutor({
      allowlist: ["npm run verify"],
      defaultTimeoutMs: 30_000,
    });

    const result = await executor.run("rm -rf /", "/workspaces/task-1");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not on the fallback allowlist");
  });

  it("runs an allowlisted command and returns its output", async () => {
    const executor = new HostCommandFallbackExecutor({
      allowlist: ["echo ok"],
      defaultTimeoutMs: 30_000,
    });

    const result = await executor.run("echo ok", "/tmp");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("kills an allowlisted command that exceeds the timeout", async () => {
    const executor = new HostCommandFallbackExecutor({
      allowlist: ["sleep 10"],
      defaultTimeoutMs: 50,
    });

    const start = Date.now();
    const result = await executor.run("sleep 10", "/tmp");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("does not expose blocked host secrets to the command environment", async () => {
    const previous = process.env.MY_FAKE_HOST_SECRET;
    process.env.MY_FAKE_HOST_SECRET = "super-secret-value";
    try {
      const executor = new HostCommandFallbackExecutor({
        allowlist: ["echo $MY_FAKE_HOST_SECRET"],
        defaultTimeoutMs: 30_000,
        blockedEnv: ["MY_FAKE_HOST_SECRET"],
      });

      const result = await executor.run("echo $MY_FAKE_HOST_SECRET", "/tmp");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("super-secret-value");
      expect(result.stdout.trim()).toBe("");
    } finally {
      if (previous === undefined) {
        delete process.env.MY_FAKE_HOST_SECRET;
      } else {
        process.env.MY_FAKE_HOST_SECRET = previous;
      }
    }
  });

  it("does not expose a raw interactive shell or credentials to the command", async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_fallback_test_token";
    try {
      const executor = new HostCommandFallbackExecutor({
        allowlist: ["echo $0"],
        defaultTimeoutMs: 30_000,
      });

      const result = await executor.run("echo $0", "/tmp");

      // The executor runs a non-interactive bash -c shell; $0 is /bin/bash, not
      // a user-controlled interactive shell. The GITHUB_TOKEN is stripped.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("ghp_fallback_test_token");
      expect(result.stdout).toContain("bash");
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previous;
      }
    }
  });

  it("does not expose provider-scoped API_KEY env vars to the command", async () => {
    const previous = process.env.PROVIDER_CUSTOM_LLM_API_KEY;
    process.env.PROVIDER_CUSTOM_LLM_API_KEY = "provider-api-key-secret";
    try {
      const executor = new HostCommandFallbackExecutor({
        allowlist: ["env"],
        defaultTimeoutMs: 30_000,
      });

      const result = await executor.run("env", "/tmp");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("provider-api-key-secret");
      expect(result.stdout).not.toContain("PROVIDER_CUSTOM_LLM_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.PROVIDER_CUSTOM_LLM_API_KEY;
      } else {
        process.env.PROVIDER_CUSTOM_LLM_API_KEY = previous;
      }
    }
  });

  it("does not expose provider-scoped HEADERS env vars to the command", async () => {
    const previous = process.env.PROVIDER_CUSTOM_LLM_HEADERS;
    process.env.PROVIDER_CUSTOM_LLM_HEADERS = '{"Authorization":"Bearer secret"}';
    try {
      const executor = new HostCommandFallbackExecutor({
        allowlist: ["env"],
        defaultTimeoutMs: 30_000,
      });

      const result = await executor.run("env", "/tmp");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Bearer secret");
      expect(result.stdout).not.toContain("PROVIDER_CUSTOM_LLM_HEADERS");
    } finally {
      if (previous === undefined) {
        delete process.env.PROVIDER_CUSTOM_LLM_HEADERS;
      } else {
        process.env.PROVIDER_CUSTOM_LLM_HEADERS = previous;
      }
    }
  });
});

function fakeDockerClient(result: FallbackCommandResult): DockerClient {
  let created: {
    containerId: string;
    spec: DockerContainerSpec;
  } | undefined;
  return {
    createContainer: async (spec) => {
      created = { containerId: "container-1", spec };
      return created;
    },
    runCommand: async (_container, input) => {
      return {
        ...result,
        stdout: `${result.stdout} cwd=${input.cwd} timeout=${input.timeoutMs}`,
      };
    },
    removeContainer: async () => {},
  };
}

describe("DockerContainerFallbackExecutor", () => {
  const baseSpec: DockerContainerSpec = {
    image: "alpine:latest",
    hostWorkspacePath: "/workspaces/task-1",
    guestWorkspacePath: "/workspace",
    mountDockerSocket: false,
  };

  it("rejects a command that is not on the allowlist", async () => {
    const executor = new DockerContainerFallbackExecutor({
      docker: fakeDockerClient({ exitCode: 0, stdout: "", stderr: "" }),
      spec: baseSpec,
      allowlist: ["npm run verify"],
      defaultTimeoutMs: 30_000,
    });

    const result = await executor.run("rm -rf /", "/workspaces/task-1/web");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not on the fallback allowlist");
  });

  it("runs an allowlisted command in a created container", async () => {
    const docker = fakeDockerClient({ exitCode: 0, stdout: "ok", stderr: "" });
    const executor = new DockerContainerFallbackExecutor({
      docker,
      spec: baseSpec,
      allowlist: ["npm run verify"],
      defaultTimeoutMs: 30_000,
    });

    const result = await executor.run("npm run verify", "/workspaces/task-1/web");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("removes the container even when the command fails", async () => {
    let removed = false;
    const docker: DockerClient = {
      createContainer: async (spec) => ({ containerId: "c-1", spec }),
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
      removeContainer: async () => {
        removed = true;
      },
    };
    const executor = new DockerContainerFallbackExecutor({
      docker,
      spec: baseSpec,
      allowlist: ["npm run verify"],
      defaultTimeoutMs: 30_000,
    });

    await executor.run("npm run verify", "/workspaces/task-1/web");

    expect(removed).toBe(true);
  });

  it("kills an allowlisted container command that exceeds the timeout", async () => {
    let killed = false;
    const docker: DockerClient = {
      createContainer: async (spec) => ({ containerId: "c-1", spec }),
      runCommand: async (_container, input) => {
        await new Promise((resolve) => setTimeout(resolve, input.timeoutMs + 50));
        killed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      removeContainer: async () => {},
    };
    const executor = new DockerContainerFallbackExecutor({
      docker,
      spec: baseSpec,
      allowlist: ["npm run verify"],
      defaultTimeoutMs: 50,
    });

    const start = Date.now();
    const result = await executor.run("npm run verify", "/workspaces/task-1/web");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
    expect(killed).toBe(false);
  });

  it("does not expose blocked host secrets to the container environment", async () => {
    const previous = process.env.MY_FAKE_DOCKER_SECRET;
    process.env.MY_FAKE_DOCKER_SECRET = "docker-secret";
    try {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const docker: DockerClient = {
        createContainer: async (spec) => ({ containerId: "c-1", spec }),
        runCommand: async (_container, input) => {
          capturedEnv = input.env;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        removeContainer: async () => {},
      };
      const executor = new DockerContainerFallbackExecutor({
        docker,
        spec: baseSpec,
        allowlist: ["env"],
        defaultTimeoutMs: 30_000,
        blockedEnv: ["MY_FAKE_DOCKER_SECRET"],
      });

      await executor.run("env", "/workspaces/task-1/web");

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv).not.toHaveProperty("MY_FAKE_DOCKER_SECRET", "docker-secret");
    } finally {
      if (previous === undefined) {
        delete process.env.MY_FAKE_DOCKER_SECRET;
      } else {
        process.env.MY_FAKE_DOCKER_SECRET = previous;
      }
    }
  });

  it("uses a container spec with no Docker socket mount", async () => {
    let capturedSpec: DockerContainerSpec | undefined;
    const docker: DockerClient = {
      createContainer: async (spec) => {
        capturedSpec = spec;
        return { containerId: "c-1", spec };
      },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      removeContainer: async () => {},
    };
    const executor = new DockerContainerFallbackExecutor({
      docker,
      spec: baseSpec,
      allowlist: ["env"],
      defaultTimeoutMs: 30_000,
    });

    await executor.run("env", "/workspaces/task-1/web");

    expect(capturedSpec).toBeDefined();
    expect(capturedSpec?.mountDockerSocket).toBe(false);
  });

  it("does not expose provider-scoped API_KEY env vars to the container", async () => {
    const previous = process.env.PROVIDER_DOCKER_LLM_API_KEY;
    process.env.PROVIDER_DOCKER_LLM_API_KEY = "docker-provider-api-key";
    try {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const docker: DockerClient = {
        createContainer: async (spec) => ({ containerId: "c-1", spec }),
        runCommand: async (_container, input) => {
          capturedEnv = input.env;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        removeContainer: async () => {},
      };
      const executor = new DockerContainerFallbackExecutor({
        docker,
        spec: baseSpec,
        allowlist: ["env"],
        defaultTimeoutMs: 30_000,
      });

      await executor.run("env", "/workspaces/task-1/web");

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv).not.toHaveProperty("PROVIDER_DOCKER_LLM_API_KEY", "docker-provider-api-key");
      expect(capturedEnv).not.toHaveProperty("PROVIDER_DOCKER_LLM_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.PROVIDER_DOCKER_LLM_API_KEY;
      } else {
        process.env.PROVIDER_DOCKER_LLM_API_KEY = previous;
      }
    }
  });

  it("does not expose provider-scoped HEADERS env vars to the container", async () => {
    const previous = process.env.PROVIDER_DOCKER_LLM_HEADERS;
    process.env.PROVIDER_DOCKER_LLM_HEADERS = '{"X-Api-Key":"docker-header-secret"}';
    try {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const docker: DockerClient = {
        createContainer: async (spec) => ({ containerId: "c-1", spec }),
        runCommand: async (_container, input) => {
          capturedEnv = input.env;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        removeContainer: async () => {},
      };
      const executor = new DockerContainerFallbackExecutor({
        docker,
        spec: baseSpec,
        allowlist: ["env"],
        defaultTimeoutMs: 30_000,
      });

      await executor.run("env", "/workspaces/task-1/web");

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv).not.toHaveProperty("PROVIDER_DOCKER_LLM_HEADERS", '{"X-Api-Key":"docker-header-secret"}');
      expect(capturedEnv).not.toHaveProperty("PROVIDER_DOCKER_LLM_HEADERS");
    } finally {
      if (previous === undefined) {
        delete process.env.PROVIDER_DOCKER_LLM_HEADERS;
      } else {
        process.env.PROVIDER_DOCKER_LLM_HEADERS = previous;
      }
    }
  });
});

describe("self-hosted fallback dependency constraints", () => {
  it("does not import any managed sandbox provider SDK", async () => {
    const fallbackModule = await import("../src/agentturn/fallback.js");
    expect(fallbackModule).toBeDefined();
    // The import succeeds because the module only uses Node built-ins. No
    // E2B/Daytona/Vercel/Cloudflare packages are referenced.
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../src/agentturn/fallback.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("@e2b/");
    expect(source).not.toContain("@daytona/");
    expect(source).not.toContain("@vercel/");
    expect(source).not.toContain("@cloudflare/");
  });

  it("produces a Docker CLI client spec without a socket mount", async () => {
    const client = createDockerCliClient({
      image: "alpine:latest",
      hostWorkspacePath: "/workspaces/task-1",
      guestWorkspacePath: "/workspace",
    });
    const container = await client.createContainer({
      image: "alpine:latest",
      hostWorkspacePath: "/workspaces/task-1",
      guestWorkspacePath: "/workspace",
      mountDockerSocket: false,
    });
    expect(container).toMatchObject({
      containerId: expect.stringMatching(/^docker-run-/),
    });
    expect(container.spec.mountDockerSocket).toBe(false);
  });
});
