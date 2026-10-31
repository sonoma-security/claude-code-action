#!/usr/bin/env bun

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("runClaudeWithSdk", () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    process.env.RUNNER_TEMP = originalRunnerTemp;
  });

  test("writes the execution file when the SDK throws after yielding messages", async () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});

    tempDir = await mkdtemp(join(tmpdir(), "claude-sdk-"));
    process.env.RUNNER_TEMP = tempDir;

    const promptPath = join(tempDir, "prompt.txt");
    await writeFile(promptPath, "test prompt");

    const initMessage = {
      type: "system",
      subtype: "init",
      session_id: "session-123",
      model: "claude-sonnet-4-6",
    };

    const close = mock(() => {});
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: () =>
        Object.assign(
          (async function* () {
            yield initMessage;
            throw new Error("Claude Code returned error_max_turns");
          })(),
          { close },
        ),
    }));

    try {
      const { runClaudeWithSdk } = await import("../src/run-claude-sdk");

      await expect(
        runClaudeWithSdk(promptPath, {
          sdkOptions: {},
          showFullOutput: false,
          hasJsonSchema: false,
        }),
      ).rejects.toThrow("SDK execution error");
      expect(close).toHaveBeenCalledTimes(1);

      const executionFile = join(tempDir, "claude-execution-output.json");
      await expect(readFile(executionFile, "utf-8")).resolves.toBe(
        JSON.stringify([initMessage], null, 2),
      );
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  for (const success of [true, false]) {
    test(`persists and closes a terminal ${success ? "success" : "failure"} without awaiting stream shutdown`, async () => {
      const log = spyOn(console, "log").mockImplementation(() => {});
      const error = spyOn(console, "error").mockImplementation(() => {});
      tempDir = await mkdtemp(join(tmpdir(), "claude-sdk-terminal-"));
      process.env.RUNNER_TEMP = tempDir;
      const promptPath = join(tempDir, "prompt.txt");
      await writeFile(promptPath, "test prompt");
      const message = {
        type: "result",
        subtype: success ? "success" : "error_max_turns",
        is_error: !success,
        duration_ms: 10,
        num_turns: 1,
        total_cost_usd: 0,
        errors: success ? undefined : ["turn limit"],
      };
      let reads = 0;
      const close = mock(() => {});
      const finish = mock(() => new Promise(() => {}));
      mock.module("@anthropic-ai/claude-agent-sdk", () => ({
        query: () => ({
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () =>
            ++reads === 1
              ? Promise.resolve({ done: false, value: message })
              : new Promise(() => {}),
          return: finish,
          close,
        }),
      }));
      try {
        const { runClaudeWithSdk } = await import("../src/run-claude-sdk");
        const pending = runClaudeWithSdk(promptPath, {
          sdkOptions: {},
          showFullOutput: false,
          hasJsonSchema: false,
        });
        if (success) expect((await pending).conclusion).toBe("success");
        else await expect(pending).rejects.toThrow("turn limit");
        expect(reads).toBe(1);
        expect(finish).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
        expect(
          JSON.parse(
            await readFile(
              join(tempDir, "claude-execution-output.json"),
              "utf8",
            ),
          ),
        ).toEqual([message]);
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    }, 1000);
  }
});
