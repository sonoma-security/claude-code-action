import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = { environment?: { name: string }; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };
// CI pins Bun 1.3.14; the repository's older Bun types predate its YAML API.
const yaml = (Bun as unknown as { YAML: { parse(text: string): unknown } })
  .YAML;
const files = [
  "test-base-action.yml",
  "test-custom-executables.yml",
  "test-mcp-servers.yml",
  "test-settings.yml",
  "test-structured-output.yml",
  "claude-review.yml",
];
const workflows = files.map((file) => ({
  file,
  workflow: yaml.parse(
    readFileSync(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      "utf8",
    ),
  ) as Workflow,
}));

function run(step: Step, outputs: Record<string, string>, temp: string) {
  // Resolve the actual workflow's GitHub output references before running Bash.
  // This also reproduces the vulnerable behavior if an expression returns to run:.
  const expand = (text: string) =>
    text
      .replace(
        /\$\{\{\s*steps\.[\w-]+\.outputs\.(\w+)\s*}}/g,
        (_, key: string) => outputs[key] ?? "",
      )
      .replace(/\$\{\{\s*secrets\.CLAUDE_CODE_OAUTH_TOKEN\s*}}/g, "");
  const env = Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [key, expand(value)]),
  );
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", expand(step.run ?? "")],
    {
      cwd: temp,
      env: { PATH: process.env.PATH, RUNNER_TEMP: temp, ...env },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, log: result.stdout + result.stderr };
}

function isolated(check: (temp: string) => void) {
  const temp = mkdtempSync(join(tmpdir(), "claude-workflow-unit-"));
  try {
    check(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const credentialed = workflows.flatMap(({ file, workflow }) =>
  Object.entries(workflow.jobs)
    .filter(([, job]) =>
      job.steps?.some(
        (step) =>
          step.uses === "./base-action" ||
          step.uses?.startsWith("anthropics/claude-code-action@"),
      ),
    )
    .map(([name, job]) => ({ label: `${file}:${name}`, job })),
);

describe("CI credential boundary", () => {
  const contexts = [
    { label: "same-repository PR", event: "pull_request", expected: true },
    { label: "fork PR", event: "pull_request", fork: true },
    { label: "draft PR", event: "pull_request", draft: true },
    { label: "Dependabot", event: "pull_request", actor: "dependabot[bot]" },
    { label: "PR target", event: "pull_request_target" },
    {
      label: "main push",
      event: "push",
      main: true,
      noPR: true,
      expected: true,
    },
    { label: "branch push", event: "push", noPR: true },
    {
      label: "main dispatch",
      event: "workflow_dispatch",
      main: true,
      noPR: true,
      expected: true,
    },
    { label: "branch dispatch", event: "workflow_dispatch", noPR: true },
    { label: "reusable own PR", event: "workflow_call", expected: true },
    { label: "reusable fork", event: "workflow_call", fork: true },
    {
      label: "reusable main",
      event: "workflow_call",
      main: true,
      noPR: true,
      expected: true,
    },
    { label: "issue comment", event: "issue_comment" },
  ];
  for (const { label, job } of credentialed) {
    test(`${label} selects an empty environment for untrusted contexts`, () => {
      const expression = job.environment!.name.trim().slice(3, -2).trim();
      // Only trusted checked-in expression text is compiled; fixture values are arguments.
      const choose = new Function("github", `return (${expression});`);
      for (const context of contexts) {
        const selected = choose({
          event_name: context.event,
          actor: context.actor ?? "unit-test-owner",
          repository: "unit-test/action",
          ref: context.main ? "refs/heads/main" : "refs/pull/1/merge",
          event: {
            pull_request: {
              draft: context.draft ?? false,
              head: {
                repo: {
                  full_name: context.noPR
                    ? ""
                    : context.fork
                      ? "outsider/action"
                      : "unit-test/action",
                },
              },
            },
          },
        });
        expect({ context: context.label, selected }).toEqual({
          context: context.label,
          selected: context.expected
            ? "security-ci-claude"
            : "security-ci-untrusted",
        });
      }
    });
    test(`${label} fails before checkout when the token is absent`, () =>
      isolated((temp) => {
        const step = job.steps![0]!;
        const missing = run(step, {}, temp);
        expect(missing.status).toBe(1);
        expect(missing.log).toContain("authentication is unavailable");
        const supplied = run(
          { ...step, env: { CLAUDE_CI_TOKEN: "unit-test-not-a-credential" } },
          {},
          temp,
        );
        expect(supplied.status).toBe(0);
        expect(supplied.log).not.toContain("unit-test-not-a-credential");
      }));
  }
});

const structured = workflows.find(
  ({ file }) => file === "test-structured-output.yml",
)!.workflow;
const valid = {
  "test-basic-types": {
    text_field: "hello",
    number_field: 42,
    boolean_true: true,
    boolean_false: false,
  },
  "test-complex-types": {
    items: ["apple", "banana", "cherry"],
    config: { key: "value", count: 3 },
    empty_array: [],
  },
  "test-edge-cases": { zero: 0, empty_string: "", negative: -5, decimal: 3.14 },
  "test-name-sanitization": { "test-result": "passed", item_count: 10 },
};
for (const [name, value] of Object.entries(valid)) {
  test(`${name} verifies JSON without interpreting quotes, newlines, or commands`, () =>
    isolated((temp) => {
      const step = structured.jobs[name]!.steps!.find(
        (step) => step.env?.ACTION_STRUCTURED_OUTPUT,
      )!;
      const sentinel = join(temp, "executed");
      const marker = "UNIT_TEST_PRIVATE_RESPONSE";
      const payload = `'; touch '${sentinel}'; #\n$(touch '${sentinel}')\n${marker}`;
      expect(
        run(step, { structured_output: JSON.stringify(value) }, temp).status,
      ).toBe(0);
      const poisoned = Object.fromEntries(
        Object.keys(value).map((key) => [key, payload]),
      );
      const result = run(
        step,
        { structured_output: JSON.stringify(poisoned) },
        temp,
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      expect(result.log).not.toContain(marker);
    }));
}

for (const { file, workflow } of workflows) {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.env?.ACTION_EXECUTION_FILE) continue;
      test(`${file}:${name} treats execution paths and conclusions as data`, () =>
        isolated((temp) => {
          const path = join(temp, "execution with spaces.json");
          writeFileSync(
            path,
            JSON.stringify([
              {
                type: "result",
                structured_output: { done: true },
                content:
                  "package.json Hello from settings test Hello from settings file test Permission to use Bash with command echo has been denied UNIT_TEST_PRIVATE_RESPONSE",
              },
            ]),
          );
          const success = run(
            step,
            { execution_file: path, conclusion: "success" },
            temp,
          );
          // Allow and deny settings checks need different execution data.
          if (name.includes("allow")) {
            writeFileSync(
              path,
              JSON.stringify([
                {
                  content:
                    "Hello from settings test Hello from settings file test UNIT_TEST_PRIVATE_RESPONSE",
                },
              ]),
            );
          }
          const positive = run(
            step,
            { execution_file: path, conclusion: "success" },
            temp,
          );
          expect(positive.status).toBe(0);
          expect(success.log + positive.log).not.toContain(
            "UNIT_TEST_PRIVATE_RESPONSE",
          );
          const sentinel = join(temp, "executed");
          const payload = `\"; touch '${sentinel}'; #\n$(touch '${sentinel}')UNIT_TEST_PRIVATE_RESPONSE`;
          const negative = run(
            step,
            { execution_file: payload, conclusion: payload },
            temp,
          );
          expect(negative.status).not.toBe(0);
          expect(existsSync(sentinel)).toBe(false);
          expect(negative.log).not.toContain("UNIT_TEST_PRIVATE_RESPONSE");
        }));
    }
  }
}

for (const [name, job] of Object.entries(
  workflows.find(({ file }) => file === "test-mcp-servers.yml")!.workflow.jobs,
)) {
  const step = job.steps!.find((step) =>
    step.name?.startsWith("Check MCP server output"),
  )!;
  test(`${name} checks MCP metadata without dumping execution data`, () =>
    isolated((temp) => {
      const path = join(temp, "claude-execution-output.json");
      const init = {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "test-server", status: "connected" }],
        tools: ["mcp__test-server__test_tool"],
      };
      writeFileSync(
        path,
        JSON.stringify([
          init,
          { type: "assistant", content: "UNIT_TEST_PRIVATE_RESPONSE" },
        ]),
      );
      const good = run(step, {}, temp);
      expect(good.status).toBe(0);
      for (const bad of [
        { ...init, mcp_servers: "UNIT_TEST_PRIVATE_RESPONSE" },
        { ...init, tools: [] },
      ]) {
        writeFileSync(
          path,
          JSON.stringify([bad, { content: "UNIT_TEST_PRIVATE_RESPONSE" }]),
        );
        const result = run(step, {}, temp);
        expect(result.status).not.toBe(0);
        expect(result.log).not.toContain("UNIT_TEST_PRIVATE_RESPONSE");
      }
      expect(good.log).not.toContain("UNIT_TEST_PRIVATE_RESPONSE");
    }));
}
