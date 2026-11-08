/**
 * Integration test, wires the real MCP server up to an in-process Client
 * via InMemoryTransport, then exercises tools through the protocol.
 *
 * This is what verifies the whole MCP wiring (schema registration, request
 * routing, response serialization) actually works.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnyHookMcpServer } from "./server";

async function setupClient() {
  const server = createAnyHookMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function parseToolResult(result: unknown): unknown {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

/** Runs the events card's script against a stand-in for the host page. */
function runCard(html: string) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const sent: { id?: number; method: string; params?: { height?: number } }[] = [];
  const parent = { postMessage: (m: (typeof sent)[number]) => sent.push(m) };
  const root = { innerHTML: "" };
  const documentElement = { style: { colorScheme: "" } };
  let onMessage: (e: unknown) => void = () => {};
  class ResizeObserver {
    constructor(private readonly report: () => void) {}
    observe() { this.report(); }
  }
  runInNewContext(script, {
    ResizeObserver,
    window: { parent, addEventListener: (_: string, fn: (e: unknown) => void) => { onMessage = fn; } },
    document: { getElementById: () => root, documentElement, body: { getBoundingClientRect: () => ({ height: 120.4 }) } },
  });
  return { sent, root, documentElement, fromHost: (data: unknown) => onMessage({ source: parent, data }) };
}

describe("MCP server integration", () => {
  it("the events card introduces itself and reports its height, or claude.ai never shows it", async () => {
    const { client } = await setupClient();
    const { resources } = await client.listResources();
    const { contents } = await client.readResource({ uri: resources.find((r) => r.name === "anyhook-events-card")!.uri });
    const card = runCard((contents[0] as { text: string }).text);

    expect(card.sent).toEqual([expect.objectContaining({ id: 1, method: "ui/initialize" })]);

    card.fromHost({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "dark" } } });
    expect(card.sent.map((m) => m.method)).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
      "ui/notifications/size-changed",
    ]);
    expect(card.sent[2].params?.height).toBe(121);
    expect(card.documentElement.style.colorScheme).toBe("dark");

    card.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { events: [{ id: "abcdefgh12", eventType: "<b>x", status: "failed", source: "stripe" }] } },
    });
    expect(card.root.innerHTML).toContain("chip failed");
    expect(card.root.innerHTML).toContain("&lt;b&gt;x");
  });

  it("exposes all 19 anyhook_* tools via listTools (account tools guarded, not hidden)", async () => {
    const { client } = await setupClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "anyhook_apps_create",
      "anyhook_apps_list",
      "anyhook_code_deploy",
      "anyhook_code_get",
      "anyhook_code_test",
      "anyhook_connect",
      "anyhook_destination_add",
      "anyhook_events",
      "anyhook_inbox",
      "anyhook_inspect",
      "anyhook_mock",
      "anyhook_providers",
      "anyhook_quickstart",
      "anyhook_replay",
      "anyhook_replay_failed",
      "anyhook_simulate",
      "anyhook_undelivered",
      "anyhook_usage",
      "anyhook_verify",
    ]);
  });

  it("guarded account tool without a key points at anyhook_quickstart", async () => {
    const { client } = await setupClient();
    const result = await client.callTool({ name: "anyhook_apps_list", arguments: {} });
    const data = parseToolResult(result) as { error?: string; fix?: string };
    expect(data.error).toContain("No API key");
    expect(data.fix).toContain("anyhook_quickstart");
  });

  it("anyhook_providers returns the catalog", async () => {
    const { client } = await setupClient();
    const result = await client.callTool({ name: "anyhook_providers", arguments: {} });
    const data = parseToolResult(result) as { providers: Array<{ provider: string; events: string[] }> };
    expect(data.providers.map((p) => p.provider).sort()).toEqual(["github", "slack", "stripe"]);
  });

  it("anyhook_mock + anyhook_verify round-trip succeeds", async () => {
    const { client } = await setupClient();

    const mockResult = await client.callTool({
      name: "anyhook_mock",
      arguments: { provider: "stripe", event: "payment_intent.succeeded", secret: "test_secret" },
    });
    const mockData = parseToolResult(mockResult) as { headers: Record<string, string>; body: string };
    expect(mockData.headers["stripe-signature"]).toBeDefined();

    const verifyResult = await client.callTool({
      name: "anyhook_verify",
      arguments: {
        provider: "stripe",
        headers: mockData.headers,
        body: mockData.body,
        secret: "test_secret",
      },
    });
    const verifyData = parseToolResult(verifyResult) as { valid: boolean };
    expect(verifyData.valid).toBe(true);
  });

  it("anyhook_simulate + anyhook_events + anyhook_inspect flow works end-to-end", async () => {
    const { client } = await setupClient();

    const sim = await client.callTool({
      name: "anyhook_simulate",
      arguments: { provider: "github", event: "pull_request.opened" },
    });
    const simData = parseToolResult(sim) as { id: string };
    expect(simData.id).toBeDefined();

    const list = await client.callTool({
      name: "anyhook_events",
      arguments: { source: "github" },
    });
    const listData = parseToolResult(list) as { events: Array<{ id: string }> };
    expect(listData.events.length).toBe(1);
    expect(listData.events[0].id).toBe(simData.id);

    const inspect = await client.callTool({
      name: "anyhook_inspect",
      arguments: { id: simData.id },
    });
    const inspectData = parseToolResult(inspect) as { eventType: string };
    expect(inspectData.eventType).toBe("pull_request.opened");
  });

  it("anyhook_mock returns an error for an unknown event", async () => {
    const { client } = await setupClient();
    const result = await client.callTool({
      name: "anyhook_mock",
      arguments: { provider: "stripe", event: "totally.fake.event" },
    });
    const r = result as { isError: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Unknown event");
  });
});
