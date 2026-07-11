import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test } from "vitest";

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
});
