import { describe, expect, it } from "vitest";
import { gitIdentityEnv, gitIdentityFrom } from "../src/github/tools.js";

describe("gitIdentityFrom", () => {
  it("uses public email when present", () => {
    expect(
      gitIdentityFrom({
        id: 42,
        login: "octocat",
        name: "The Octocat",
        email: "octocat@github.com",
      } as Parameters<typeof gitIdentityFrom>[0]),
    ).toEqual({
      name: "The Octocat",
      email: "octocat@github.com",
    });
  });

  it("falls back to login for name and id+login no-reply email", () => {
    expect(
      gitIdentityFrom({
        id: 99,
        login: "bot-user",
        name: null,
        email: null,
      } as Parameters<typeof gitIdentityFrom>[0]),
    ).toEqual({
      name: "bot-user",
      email: "99+bot-user@users.noreply.github.com",
    });
  });
});

describe("gitIdentityEnv", () => {
  it("maps identity to git author and committer env vars", () => {
    expect(
      gitIdentityEnv({ name: "Alice", email: "alice@example.com" }),
    ).toEqual({
      GIT_AUTHOR_NAME: "Alice",
      GIT_AUTHOR_EMAIL: "alice@example.com",
      GIT_COMMITTER_NAME: "Alice",
      GIT_COMMITTER_EMAIL: "alice@example.com",
    });
  });
});
