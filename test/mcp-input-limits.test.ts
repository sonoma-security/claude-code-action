import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createLimitedMcpServer } from "../src/mcp/server-limits";

async function exercise(items: string[], oversized: boolean) {
  const server = createLimitedMcpServer({
    name: "unit-test",
    version: "1.0.0",
  });
  const client = new Client({ name: "unit-test-client", version: "1.0.0" });
  let calls = 0;
  server.registerTool(
    "bounded_echo",
    { inputSchema: { items: z.array(z.string()) } },
    async ({ items }) => {
      calls += 1;
      return { content: [{ type: "text", text: String(items.length) }] };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    if (oversized) {
      expect(
        await client.callTool({ name: "bounded_echo", arguments: { items } }),
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringMatching(/element/i) }],
      });
      expect(calls).toBe(0);
    } else {
      expect(
        await client.callTool({ name: "bounded_echo", arguments: { items } }),
      ).toMatchObject({
        content: [{ type: "text", text: String(items.length) }],
      });
      expect(calls).toBe(1);
    }
  } finally {
    await client.close();
    await server.close();
  }
}

test("oversized tool input is rejected before the handler runs", async () => {
  await exercise(
    Array.from({ length: 10_001 }, () => "unit-test"),
    true,
  );
});

test("ordinary tool input still reaches the handler", async () => {
  await exercise(["first", "second"], false);
});
