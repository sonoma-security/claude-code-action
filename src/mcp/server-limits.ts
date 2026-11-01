import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createLimitedMcpServer(
  info: ConstructorParameters<typeof McpServer>[0],
): McpServer {
  return new McpServer(info, { maxToolInputElements: 10_000 });
}
