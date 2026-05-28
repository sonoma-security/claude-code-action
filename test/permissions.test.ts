import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import * as core from "@actions/core";
import { checkWritePermissions } from "../src/github/validation/permissions";
import type { ParsedGitHubContext } from "../src/github/context";
import { CLAUDE_APP_BOT_ID, CLAUDE_BOT_LOGIN } from "../src/github/constants";

describe("checkWritePermissions", () => {
  let coreInfoSpy: any;
  let coreWarningSpy: any;
  let coreErrorSpy: any;

  beforeEach(() => {
    // Spy on core methods
    coreInfoSpy = spyOn(core, "info").mockImplementation(() => {});
    coreWarningSpy = spyOn(core, "warning").mockImplementation(() => {});
    coreErrorSpy = spyOn(core, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    coreInfoSpy.mockRestore();
    coreWarningSpy.mockRestore();
    coreErrorSpy.mockRestore();
  });

  const createMockOctokit = (permission: string) => {
    return {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission },
        }),
      },
    } as any;
  };

  const createContext = (): ParsedGitHubContext => ({
    runId: "1234567890",
    eventName: "issue_comment",
    eventAction: "created",
    repository: {
      full_name: "test-owner/test-repo",
      owner: "test-owner",
      repo: "test-repo",
    },
    actor: "test-user",
    payload: {
      action: "created",
      issue: {
        number: 1,
        title: "Test Issue",
        body: "Test body",
        user: { login: "test-user" },
      },
      comment: {
        id: 123,
        body: "@claude test",
        user: { login: "test-user" },
        html_url:
          "https://github.com/test-owner/test-repo/issues/1#issuecomment-123",
      },
    } as any,
    entityNumber: 1,
    isPR: false,
    inputs: {
      prompt: "",
      triggerPhrase: "@claude",
      assigneeTrigger: "",
      labelTrigger: "",
      branchPrefix: "claude/",
      useStickyComment: false,
      classifyInlineComments: true,
      useCommitSigning: false,
      sshSigningKey: "",
      botId: String(CLAUDE_APP_BOT_ID),
      botName: CLAUDE_BOT_LOGIN,
      allowedBots: "",
      allowedNonWriteUsers: "",
      trackProgress: false,
      includeFixLinks: true,
      includeCommentsByActor: "",
      excludeCommentsByActor: "",
    },
  });

  test("should return true for admin permissions", async () => {
    const mockOctokit = createMockOctokit("admin");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(true);
    expect(coreInfoSpy).toHaveBeenCalledWith(
      "Checking permissions for actor: test-user",
    );
    expect(coreInfoSpy).toHaveBeenCalledWith(
      "Permission level retrieved: admin",
    );
    expect(coreInfoSpy).toHaveBeenCalledWith("Actor has write access: admin");
  });

  test("should return true for write permissions", async () => {
    const mockOctokit = createMockOctokit("write");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(true);
    expect(coreInfoSpy).toHaveBeenCalledWith("Actor has write access: write");
  });

  test("should return false for read permissions", async () => {
    const mockOctokit = createMockOctokit("read");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(false);
    expect(coreWarningSpy).toHaveBeenCalledWith(
      "Actor has insufficient permissions: read",
    );
  });

  test("should return false for none permissions", async () => {
    const mockOctokit = createMockOctokit("none");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(false);
    expect(coreWarningSpy).toHaveBeenCalledWith(
      "Actor has insufficient permissions: none",
    );
  });

  test("should return true for bot user", async () => {
    const mockOctokit = createMockOctokit("none");
    const context = createContext();
    context.actor = "test-bot[bot]";

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(true);
  });

  test("should throw error when permission check fails", async () => {
    const error = new Error("API error");
    const mockOctokit = {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          throw error;
        },
      },
    } as any;
    const context = createContext();

    await expect(checkWritePermissions(mockOctokit, context)).rejects.toThrow(
      "Failed to check permissions for test-user: Error: API error",
    );

    expect(coreErrorSpy).toHaveBeenCalledWith(
      "Failed to check permissions: Error: API error",
    );
  });

  test("should call API with correct parameters", async () => {
    let capturedParams: any;
    const mockOctokit = {
      repos: {
        getCollaboratorPermissionLevel: async (params: any) => {
          capturedParams = params;
          return { data: { permission: "write" } };
        },
      },
    } as any;
    const context = createContext();

    await checkWritePermissions(mockOctokit, context);

    expect(capturedParams).toEqual({
      owner: "test-owner",
      repo: "test-repo",
      username: "test-user",
    });
  });

  describe("allowed_non_write_users bypass", () => {
    test("should bypass permission check for specific user when github_token provided", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();

      const result = await checkWritePermissions(
        mockOctokit,
        context,
        "test-user,other-user",
        true,
      );

      expect(result).toBe(true);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "⚠️ SECURITY WARNING: Bypassing write permission check for test-user due to allowed_non_write_users configuration. This should only be used for workflows with very limited permissions.",
      );
    });

    test("should bypass permission check for all users with wildcard", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();

      const result = await checkWritePermissions(
        mockOctokit,
        context,
        "*",
        true,
      );

      expect(result).toBe(true);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "⚠️ SECURITY WARNING: Bypassing write permission check for test-user due to allowed_non_write_users='*'. This should only be used for workflows with very limited permissions.",
      );
    });

    test("should NOT bypass permission check when user not in allowed list", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();

      const result = await checkWritePermissions(
        mockOctokit,
        context,
        "other-user,another-user",
        true,
      );

      expect(result).toBe(false);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "Actor has insufficient permissions: read",
      );
    });

    test("should NOT bypass permission check when github_token not provided", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();

      const result = await checkWritePermissions(
        mockOctokit,
        context,
        "test-user",
        false,
      );

      expect(result).toBe(false);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "Actor has insufficient permissions: read",
      );
    });

    test("should NOT bypass permission check when allowed_non_write_users is empty", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();

      const result = await checkWritePermissions(
        mockOctokit,
        context,
        "",
        true,
      );

      expect(result).toBe(false);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "Actor has insufficient permissions: read",
      );
    });

    test("should handle whitespace in allowed_non_write_users list", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();

      const result = await checkWritePermissions(
        mockOctokit,
        context,
        " test-user , other-user ",
        true,
      );

      expect(result).toBe(true);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "⚠️ SECURITY WARNING: Bypassing write permission check for test-user due to allowed_non_write_users configuration. This should only be used for workflows with very limited permissions.",
      );
    });

    test("should bypass for bot users even when allowed_non_write_users is set", async () => {
      const mockOctokit = createMockOctokit("none");
      const context = createContext();
      context.actor = "test-bot[bot]";

      const result = await checkWritePermissions(
        mockOctokit,
        context,
        "some-user",
        true,
      );

      expect(result).toBe(true);
      expect(coreInfoSpy).toHaveBeenCalledWith(
        "Actor is a GitHub App: test-bot[bot]",
      );
    });
  });

  describe("non-[bot] actors (e.g. GitHub Copilot)", () => {
    // GitHub Copilot SWE Agent sets GITHUB_ACTOR="Copilot" which doesn't
    // end with [bot] and is not a valid GitHub user, so the collaborator
    // permission API returns 404 with "is not a user". allowed_bots is
    // applied in that catch path once the API has confirmed the actor is
    // not a regular user account.

    const createMockOctokitThat404s = () =>
      ({
        repos: {
          getCollaboratorPermissionLevel: async () => {
            const err = new Error(
              "HttpError: Copilot is not a user - https://docs.github.com/rest/collaborators/collaborators#get-repository-permissions-for-a-user",
            );
            (err as any).status = 404;
            throw err;
          },
        },
      }) as any;

    test("should return true for non-[bot] app actor in allowed_bots", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "copilot,cursor";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
      expect(coreInfoSpy).toHaveBeenCalledWith(
        "Non-user actor Copilot is in allowed_bots list, granting access",
      );
    });

    test("should return true for non-[bot] app actor when allowed_bots is '*'", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "*";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });

    test("should match config entries written with the [bot] suffix", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createContext();
      context.actor = "SomeNewBot";
      context.inputs.allowedBots = "somenewbot[bot]";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });

    test("should return false for non-[bot] app actor that is not in allowed_bots", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "cursor";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "Non-user actor Copilot is not in allowed_bots list. Add it to allowed_bots or use '*' to allow all bots.",
      );
    });

    test("should return false for non-[bot] app actor with empty allowed_bots", async () => {
      const mockOctokit = createMockOctokitThat404s();
      const context = createContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });

    test("should still throw for non-404 API errors", async () => {
      const mockOctokit = {
        repos: {
          getCollaboratorPermissionLevel: async () => {
            throw new Error("Internal Server Error");
          },
        },
      } as any;
      const context = createContext();
      context.actor = "Copilot";
      context.inputs.allowedBots = "";

      await expect(checkWritePermissions(mockOctokit, context)).rejects.toThrow(
        "Failed to check permissions for Copilot",
      );
    });
  });

  describe("allowed_bots only applies to non-user actors", () => {
    // The permission endpoint resolves the actor's account type. Actors
    // that resolve to a regular user account go through the standard write
    // permission check; allowed_bots does not short-circuit it for them.

    test("should require write permission for a user account whose name matches allowed_bots", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();
      context.actor = "renovate";
      context.inputs.allowedBots = "renovate";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "Actor has insufficient permissions: read",
      );
    });

    test("should require write permission for a user account when allowed_bots uses the [bot] form", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();
      context.actor = "renovate";
      context.inputs.allowedBots = "renovate[bot]";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });

    test("should require write permission for a user account when allowed_bots is '*'", async () => {
      const mockOctokit = createMockOctokit("none");
      const context = createContext();
      context.actor = "some-user";
      context.inputs.allowedBots = "*";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });

    test("should still grant access for a user account with write permission", async () => {
      const mockOctokit = createMockOctokit("write");
      const context = createContext();
      context.actor = "renovate";
      context.inputs.allowedBots = "renovate";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });
  });

  describe("PR-author bypass for allowed_bots", () => {
    // When the event is a pull_request* event and the PR was authored by
    // a login in allowed_bots, the workflow's `if:` has already authorized
    // it on PR-author identity. Skip the collaborator-permission lookup on
    // the triggering actor — that lookup 404s for org members not listed
    // as direct collaborators and would otherwise block the workflow.

    const octokitThatMustNotBeCalled = () =>
      ({
        repos: {
          getCollaboratorPermissionLevel: async () => {
            throw new Error(
              "octokit.repos.getCollaboratorPermissionLevel should not be called when PR-author bypass applies",
            );
          },
        },
      }) as any;

    const createPullRequestContext = (
      prAuthorLogin: string,
      triggeringActor: string,
    ) => {
      const context = createContext();
      context.eventName = "pull_request";
      context.eventAction = "opened";
      context.isPR = true;
      context.actor = triggeringActor;
      context.payload = {
        action: "opened",
        number: 200,
        pull_request: {
          number: 200,
          user: { login: prAuthorLogin },
        },
      } as any;
      return context;
    };

    test("should grant access when PR author is in allowed_bots", async () => {
      const context = createPullRequestContext(
        "sonoma-ai-author",
        "human-pusher",
      );
      context.inputs.allowedBots = "sonoma-ai-author";

      const result = await checkWritePermissions(
        octokitThatMustNotBeCalled(),
        context,
      );

      expect(result).toBe(true);
      expect(coreInfoSpy).toHaveBeenCalledWith(
        "PR author sonoma-ai-author is in allowed_bots; granting access (triggering actor: human-pusher)",
      );
    });

    test("should grant access when allowed_bots is '*'", async () => {
      const context = createPullRequestContext(
        "any-bot-account",
        "human-pusher",
      );
      context.inputs.allowedBots = "*";

      const result = await checkWritePermissions(
        octokitThatMustNotBeCalled(),
        context,
      );

      expect(result).toBe(true);
    });

    test("should NOT bypass when PR author is not in allowed_bots", async () => {
      // PR author not trusted — falls through to the standard write check.
      const mockOctokit = createMockOctokit("read");
      const context = createPullRequestContext("untrusted-bot", "human-pusher");
      context.inputs.allowedBots = "sonoma-ai-author";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });

    test("should NOT bypass for issue_comment on a regular issue", async () => {
      // Non-PR event — the bypass is scoped to pull_request* event types.
      const mockOctokit = createMockOctokit("write");
      const context = createContext();
      context.actor = "human-user";
      context.inputs.allowedBots = "sonoma-ai-author";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true); // grants because triggering actor has write, not because of bypass
      expect(coreInfoSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("PR author"),
      );
    });

    test("should NOT bypass when pull_request.user is missing from payload", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();
      context.eventName = "pull_request";
      context.isPR = true;
      context.actor = "human-pusher";
      context.inputs.allowedBots = "*";
      context.payload = {
        action: "opened",
        pull_request: {},
      } as any;

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });

    test("should bypass on pull_request_review event", async () => {
      const context = createContext();
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

      const result = await checkWritePermissions(
        octokitThatMustNotBeCalled(),
        context,
      );

      expect(result).toBe(true);
    });

    test("should bypass on pull_request_review_comment event", async () => {
      const context = createContext();
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

      const result = await checkWritePermissions(
        octokitThatMustNotBeCalled(),
        context,
      );

      expect(result).toBe(true);
    });

    test("should bypass even when triggering actor would 404", async () => {
      // Concrete reproduction of the failure mode this bypass exists for:
      // triggering actor is an org admin who isn't a direct collaborator,
      // so the API would 404. The bypass short-circuits before we get there.
      const context = createPullRequestContext("sonoma-ai-author", "scobbe");
      context.inputs.allowedBots = "sonoma-ai-author";

      const mockOctokit = {
        repos: {
          getCollaboratorPermissionLevel: async () => {
            const err = new Error(
              "Not Found - https://docs.github.com/rest/collaborators/collaborators#get-repository-permissions-for-a-user",
            );
            (err as any).status = 404;
            throw err;
          },
        },
      } as any;

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });
  });
});
