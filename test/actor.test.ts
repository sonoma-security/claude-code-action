#!/usr/bin/env bun

import { describe, test, expect } from "bun:test";
import { checkHumanActor } from "../src/github/validation/actor";
import type { Octokit } from "@octokit/rest";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import { createMockContext } from "./mockContext";

function createMockOctokit(userType: string): Octokit {
  return {
    users: {
      getByUsername: async () => ({
        data: {
          type: userType,
        },
      }),
    },
  } as unknown as Octokit;
}

describe("checkHumanActor", () => {
  test("should pass for human actor", async () => {
    const mockOctokit = createMockOctokit("User");
    const context = createMockContext();
    context.actor = "human-user";

    await expect(
      checkHumanActor(mockOctokit, context),
    ).resolves.toBeUndefined();
  });

  test("should throw error for bot actor when not allowed", async () => {
    const mockOctokit = createMockOctokit("Bot");
    const context = createMockContext();
    context.actor = "test-bot[bot]";
    context.inputs.allowedBots = "";

    await expect(checkHumanActor(mockOctokit, context)).rejects.toThrow(
      "Workflow initiated by non-human actor: test-bot (type: Bot). Add bot to allowed_bots list or use '*' to allow all bots.",
    );
  });

  test("should pass for bot actor when all bots allowed", async () => {
    const mockOctokit = createMockOctokit("Bot");
    const context = createMockContext();
    context.actor = "test-bot[bot]";
    context.inputs.allowedBots = "*";

    await expect(
      checkHumanActor(mockOctokit, context),
    ).resolves.toBeUndefined();
  });

  test("should pass for specific bot when in allowed list", async () => {
    const mockOctokit = createMockOctokit("Bot");
    const context = createMockContext();
    context.actor = "dependabot[bot]";
    context.inputs.allowedBots = "dependabot[bot],renovate[bot]";

    await expect(
      checkHumanActor(mockOctokit, context),
    ).resolves.toBeUndefined();
  });

  test("should pass for specific bot when in allowed list (without [bot])", async () => {
    const mockOctokit = createMockOctokit("Bot");
    const context = createMockContext();
    context.actor = "dependabot[bot]";
    context.inputs.allowedBots = "dependabot,renovate";

    await expect(
      checkHumanActor(mockOctokit, context),
    ).resolves.toBeUndefined();
  });

  test("should throw error for bot not in allowed list", async () => {
    const mockOctokit = createMockOctokit("Bot");
    const context = createMockContext();
    context.actor = "other-bot[bot]";
    context.inputs.allowedBots = "dependabot[bot],renovate[bot]";

    await expect(checkHumanActor(mockOctokit, context)).rejects.toThrow(
      "Workflow initiated by non-human actor: other-bot (type: Bot). Add bot to allowed_bots list or use '*' to allow all bots.",
    );
  });

  test("should throw error for bot not in allowed list (without [bot])", async () => {
    const mockOctokit = createMockOctokit("Bot");
    const context = createMockContext();
    context.actor = "other-bot[bot]";
    context.inputs.allowedBots = "dependabot,renovate";

    await expect(checkHumanActor(mockOctokit, context)).rejects.toThrow(
      "Workflow initiated by non-human actor: other-bot (type: Bot). Add bot to allowed_bots list or use '*' to allow all bots.",
    );
  });

  describe("non-[bot] actors (e.g. GitHub Copilot)", () => {
    // GitHub Copilot SWE Agent sets GITHUB_ACTOR="Copilot" which is not a
    // valid GitHub user and doesn't end with [bot], causing 404 on the
    // Users API. allowed_bots is applied once the API has resolved the
    // actor as not being a regular user account.

    function createMockOctokitThat404s(): Octokit {
      return {
        users: {
          getByUsername: async () => {
            const err = new Error("Not Found");
            (err as any).status = 404;
            throw err;
          },
        },
      } as unknown as Octokit;
    }

    test("should pass for non-[bot] actor when in allowed_bots list", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createMockContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "copilot,cursor";

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });

    test("should pass for non-[bot] actor when all bots are allowed", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createMockContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "*";

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });

    test("should throw with clear message for non-[bot] actor that 404s and is not in allowed list", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createMockContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "cursor";

      await expect(checkHumanActor(mockOctokit, context)).rejects.toThrow(
        "Workflow initiated by non-human actor: copilot (actor not found on GitHub). Add bot to allowed_bots list or use '*' to allow all bots.",
      );
    });

    test("should throw with clear message for non-[bot] actor that 404s and allowed_bots is empty", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createMockContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "";

      await expect(checkHumanActor(mockOctokit, context)).rejects.toThrow(
        "Workflow initiated by non-human actor: copilot (actor not found on GitHub). Add bot to allowed_bots list or use '*' to allow all bots.",
      );
    });

    test("should match allowed_bots case-insensitively for non-[bot] actors", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createMockContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "COPILOT";

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });
  });

  describe("account type resolution", () => {
    // The Users API resolves the actor's account type before allowed_bots
    // is consulted. allowed_bots is only relevant for Bot accounts and
    // unresolvable app actors; it does not change behavior for regular
    // User accounts.

    test("should pass for a User account whose name matches allowed_bots", async () => {
      const mockOctokit = createMockOctokit("User");
      const context = createMockContext();
      context.actor = "renovate";
      context.inputs.allowedBots = "renovate";

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });

    test("should pass for a User account when allowed_bots is '*'", async () => {
      const mockOctokit = createMockOctokit("User");
      const context = createMockContext();
      context.actor = "some-user";
      context.inputs.allowedBots = "*";

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });

    test("should resolve account type even when actor name appears in allowed_bots", async () => {
      // The Users API call should not be short-circuited by allowed_bots,
      // so an unexpected API error propagates instead of being swallowed.
      const mockOctokit = {
        users: {
          getByUsername: async () => {
            throw new Error("Internal Server Error");
          },
        },
      } as unknown as Octokit;
      const context = createMockContext();
      context.actor = "some-user";
      context.inputs.allowedBots = "some-user";

      await expect(checkHumanActor(mockOctokit, context)).rejects.toThrow(
        "Internal Server Error",
      );
    });
  });

  describe("PR-author bypass for allowed_bots", () => {
    // When the event is a pull_request* event and the PR author is in
    // allowed_bots, the triggering actor's account type is irrelevant —
    // the PR-author identity is the trust signal. The user lookup is
    // skipped so a 404 on the triggering actor (e.g. an org admin not
    // listed as a direct collaborator) doesn't block the workflow.

    function createPullRequestContext(
      prAuthorLogin: string,
      triggeringActor: string,
    ) {
      const context = createMockContext();
      context.eventName = "pull_request";
      context.eventAction = "opened";
      context.isPR = true;
      context.actor = triggeringActor;
      context.payload = {
        action: "opened",
        number: 100,
        pull_request: {
          number: 100,
          user: { login: prAuthorLogin },
        },
      } as unknown as PullRequestEvent;
      return context;
    }

    function octokitThatMustNotBeCalled(): Octokit {
      return {
        users: {
          getByUsername: async () => {
            throw new Error(
              "octokit.users.getByUsername should not be called when PR-author bypass applies",
            );
          },
        },
      } as unknown as Octokit;
    }

    test("should bypass user lookup when PR author is in allowed_bots", async () => {
      const context = createPullRequestContext(
        "sonoma-ai-author",
        "human-pusher",
      );
      context.inputs.allowedBots = "sonoma-ai-author";

      await expect(
        checkHumanActor(octokitThatMustNotBeCalled(), context),
      ).resolves.toBeUndefined();
    });

    test("should bypass user lookup when allowed_bots is '*'", async () => {
      const context = createPullRequestContext(
        "any-bot-account",
        "human-pusher",
      );
      context.inputs.allowedBots = "*";

      await expect(
        checkHumanActor(octokitThatMustNotBeCalled(), context),
      ).resolves.toBeUndefined();
    });

    test("should match PR author case-insensitively", async () => {
      const context = createPullRequestContext(
        "Sonoma-AI-Author",
        "human-pusher",
      );
      context.inputs.allowedBots = "sonoma-ai-author";

      await expect(
        checkHumanActor(octokitThatMustNotBeCalled(), context),
      ).resolves.toBeUndefined();
    });

    test("should NOT bypass when PR author is not in allowed_bots", async () => {
      // PR author isn't trusted — falls through to standard actor resolution.
      const mockOctokit = createMockOctokit("User");
      const context = createPullRequestContext("untrusted-bot", "human-pusher");
      context.inputs.allowedBots = "sonoma-ai-author";

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });

    test("should NOT bypass for issue_comment on a regular issue", async () => {
      // Non-PR event — the bypass is scoped to pull_request* event types.
      const mockOctokit = createMockOctokit("User");
      const context = createMockContext();
      context.eventName = "issue_comment";
      context.isPR = false;
      context.actor = "human-user";
      context.inputs.allowedBots = "sonoma-ai-author";

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });

    test("should NOT bypass when pull_request.user is missing from payload", async () => {
      const mockOctokit = createMockOctokit("User");
      const context = createMockContext();
      context.eventName = "pull_request";
      context.isPR = true;
      context.actor = "human-user";
      context.inputs.allowedBots = "*";
      context.payload = {
        action: "opened",
        pull_request: {},
      } as unknown as PullRequestEvent;

      await expect(
        checkHumanActor(mockOctokit, context),
      ).resolves.toBeUndefined();
    });

    test("should bypass on pull_request_review event", async () => {
      const context = createMockContext();
      context.eventName = "pull_request_review";
      context.isPR = true;
      context.actor = "human-pusher";
      context.inputs.allowedBots = "sonoma-ai-author";
      context.payload = {
        action: "submitted",
        pull_request: {
          user: { login: "sonoma-ai-author" },
        },
      } as any;

      await expect(
        checkHumanActor(octokitThatMustNotBeCalled(), context),
      ).resolves.toBeUndefined();
    });

    test("should bypass on pull_request_review_comment event", async () => {
      const context = createMockContext();
      context.eventName = "pull_request_review_comment";
      context.isPR = true;
      context.actor = "human-pusher";
      context.inputs.allowedBots = "sonoma-ai-author";
      context.payload = {
        action: "created",
        pull_request: {
          user: { login: "sonoma-ai-author" },
        },
      } as any;

      await expect(
        checkHumanActor(octokitThatMustNotBeCalled(), context),
      ).resolves.toBeUndefined();
    });
  });
});
