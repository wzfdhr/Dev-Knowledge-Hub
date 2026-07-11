import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { authenticateMcpToken, hashMcpToken } from "./mcp/auth";
import { MemoryAppStore } from "./persistence/memory-store";
import { createMcpServer } from "./mcp-stdio";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("createMcpServer", () => {
  test("registers exactly the approved eight tools", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "devkh-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeCallbacks.push(() => client.close(), () => server.close());

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "dkh_get_architecture",
      "dkh_get_change_context",
      "dkh_get_module",
      "dkh_get_release",
      "dkh_get_source",
      "dkh_get_symbol",
      "dkh_report_gap",
      "dkh_search"
    ]);
  });

  test("rechecks authorization for every call on an established stdio session", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const plaintext = `dkh_${"a".repeat(43)}`;
    const token = await store.createMcpToken({
      workspaceId: setup!.workspace.id,
      name: "stdio",
      tokenHash: hashMcpToken(plaintext),
      tokenPrefix: plaintext.slice(0, 12)
    });
    const onUnauthorized = vi.fn(async () => {});
    const server = createMcpServer({
      store,
      workspaceId: setup!.workspace.id,
      authorize: async () => Boolean(await authenticateMcpToken(store, plaintext)),
      onUnauthorized
    } as never);
    const client = new Client({ name: "revocation-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeCallbacks.push(() => client.close(), () => server.close());
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const beforeRevocation = await client.callTool({ name: "dkh_get_release", arguments: {} });
    expect(JSON.stringify(beforeRevocation)).toContain("UNPUBLISHED");

    await store.revokeMcpToken(setup!.workspace.id, token.id);
    const afterRevocation = await client.callTool({ name: "dkh_get_release", arguments: {} });

    expect(afterRevocation.isError).toBe(true);
    expect(JSON.stringify(afterRevocation)).toContain("UNAUTHORIZED");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
