import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { authenticateMcpToken } from "./mcp/auth.js";
import { createRegisteredMcpServer, type McpToolContext } from "./mcp/tools.js";
import { PostgresAppStore } from "./persistence/postgres-store.js";

export function createMcpServer(context?: McpToolContext): McpServer {
  return createRegisteredMcpServer(context);
}

export async function runMcpStdio(context?: McpToolContext): Promise<void> {
  let selected = context;
  let closeDatabase: (() => Promise<void>) | undefined;
  if (!selected) {
    const databaseUrl = process.env.DATABASE_URL;
    const plaintext = process.env.DEVKH_MCP_TOKEN;
    if (!databaseUrl || !plaintext) {
      throw new Error("DATABASE_URL and DEVKH_MCP_TOKEN are required for MCP stdio startup");
    }
    const database = createDatabase(databaseUrl);
    await runMigrations(database.pool);
    const store = new PostgresAppStore(database.pool);
    const token = await authenticateMcpToken(store, plaintext);
    if (!token) {
      await database.pool.end();
      throw new Error("MCP token is invalid or revoked");
    }
    selected = { store, workspaceId: token.workspaceId };
    closeDatabase = () => database.pool.end();
  }
  const server = createMcpServer(selected);
  await server.connect(new StdioServerTransport());
  if (closeDatabase) process.once("beforeExit", closeDatabase);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMcpStdio();
}
