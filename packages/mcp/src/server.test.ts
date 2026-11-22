/**
 * Integration test, wires the real MCP server up to an in-process Client
 * via InMemoryTransport, then exercises tools through the protocol.
 *
 * This is what verifies the whole MCP wiring (schema registration, request
 * routing, response serialization) actually works.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnyHookMcpServer } from "./server";
import type { ServerOptions } from "./server";

async function setupClient(opts?: ServerOptions) {
  const server = createAnyHookMcpServer(opts);
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
  it("lets a user discover the inbox recap before connecting and read it after a stdio quickstart", async () => {
    const { client } = await setupClient({ config: { mode: "local", apiBase: "https://inbox.example" } });
    const name = "webhook-inbox-catch-up";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ inbound_url: "https://in.example/orders", api_key: "test-key" }, { status: 201 }),
    );
    try {
      expect(client.getInstructions()).toContain("which deliveries need attention?");
      expect((await client.listPrompts()).prompts).toContainEqual(expect.objectContaining({
        name, arguments: [expect.objectContaining({ name: "appSlug", required: false })],
      }));
      const offline = await client.getPrompt({ name });
      expect(offline.messages[0].content).toMatchObject({ text: expect.stringContaining("existing ANYHOOK_API_KEY") });
      expect(request).not.toHaveBeenCalled();

      await client.callTool({ name: "anyhook_quickstart", arguments: {} });
      const connected = await client.getPrompt({ name, arguments: { appSlug: "orders" } });
      expect(connected.messages[0].content).toMatchObject({ text: expect.stringContaining('app "orders" in this account') });
      const all = await client.getPrompt({ name, arguments: { appSlug: "" } });
      expect(all.messages[0].content).toMatchObject({ text: expect.stringContaining("the apps in this account") });
      await expect(client.getPrompt({ name, arguments: { appSlug: "orders\nother instructions" } })).rejects.toThrow(/invalid arguments/i);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
      await client.close();
    }
  });

  it("advertises and serves the current events card under its new cache URI", async () => {
    const { client } = await setupClient();
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const card = resources.find((r) => r.name === "anyhook-events-card");
    const uri = "ui://anyhook/events-v5.html";

    expect(tools.find((t) => t.name === "anyhook_events")?._meta).toMatchObject({ ui: { resourceUri: uri } });
    expect(card?.uri).toBe(uri);
    const { contents } = await client.readResource({ uri });
    expect(contents[0].uri).toBe(uri);
    expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect((contents[0] as { text: string }).text).toContain("stored only");
  });

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

  it("does not present stored-only or unknown events as forwarded", async () => {
    const { client } = await setupClient();
    const { resources } = await client.listResources();
    const { contents } = await client.readResource({ uri: resources.find((r) => r.name === "anyhook-events-card")!.uri });
    const card = runCard((contents[0] as { text: string }).text);
    card.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { events: [
        { id: "one", status: "success", deliveryState: "stored", outboundStatus: 0 },
        { id: "two", status: "success", deliveryState: "forwarded", outboundStatus: 200 },
        { id: "three", status: "success", deliveryState: "unknown", outboundStatus: null },
        { id: "four", status: "success", outboundStatus: 0 },
      ] } },
    });
    expect(card.root.innerHTML.match(/>stored only<\/span>/g)).toHaveLength(2);
    expect(card.root.innerHTML).toContain('chip ok">forwarded');
    expect(card.root.innerHTML).toContain('chip ">unconfirmed');
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

  it("a fresh MCP client resumes its inbox through REST with the saved key, filters, and page cursor", async () => {
    const apiBase = "https://inbox.example";
    const apiKey = "test-key";
    const when = "2026-11-19T08:00:00.123456Z";
    const cursor = `${when}_94fbc375-d092-42d3-a956-99cd1c09726c`;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/quickstart") {
        return Response.json({ inbound_url: "https://in.example/demo", api_key: apiKey }, { status: 201 });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      if (url.pathname === "/api/v1/events/e1") {
        expect(headers.get("x-anyhook-tool")).toBe("anyhook_inspect");
        return Response.json({ event: { id: "e1", inboundBody: { message: "arrived while offline" } } });
      }
      expect(headers.get("x-anyhook-tool")).toBe("anyhook_events");
      expect(url.searchParams.get("app_slug")).toBe("demo");
      expect(url.searchParams.get("since")).toBe(when);
      expect(url.searchParams.get("cursor")).toBe(cursor);
      return Response.json({ events: [{ id: "e1" }], nextCursor: null });
    });
    try {
      const first = await setupClient({ config: { apiBase, mode: "local" } });
      const created = parseToolResult(await first.client.callTool({ name: "anyhook_quickstart", arguments: {} })) as { api_key: string };
      await first.client.close();
      const second = await setupClient({ config: { apiBase, mode: "remote", apiKey: created.api_key } });
      const list = await second.client.callTool({ name: "anyhook_events", arguments: { since: when, cursor, appSlug: "demo" } });
      expect(list.structuredContent).toEqual({ events: [{ id: "e1" }], nextCursor: null });
      const detail = await second.client.callTool({ name: "anyhook_inspect", arguments: { id: "e1" } });
      expect(parseToolResult(detail)).toMatchObject({ inboundBody: { message: "arrived while offline" } });
      await second.client.close();
    } finally {
      request.mockRestore();
    }
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
