/**
 * The CLI's end of `listen`. The one test that matters most is the first: a
 * provider signature, checked over the bytes a real HTTP server received.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnyHookApiError } from "./client";
import { banner, eventLabel, eventLine, forward, localHeaders, readSaved, targetUrl, transient, writeSaved, type EventFrame } from "./listen";

const frame = (over: Partial<EventFrame> = {}): EventFrame => ({ id: "f1", headers: {}, body: "{}", ...over });

describe("forward", () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  /** A local server that keeps the raw bytes and its headers, as a verifying webhook handler has to. */
  const serve = (answer: (res: import("node:http").ServerResponse) => void) =>
    new Promise<{ url: string; got: () => { raw: Buffer; headers: Record<string, unknown> } }>((resolve) => {
      let got: { raw: Buffer; headers: Record<string, unknown> };
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          got = { raw: Buffer.concat(chunks), headers: req.headers };
          answer(res);
        });
      }).listen(0, "127.0.0.1", () => {
        const { port } = server!.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${port}/hooks`, got: () => got });
      });
    });

  it("delivers the exact bytes, so a Stripe-style signature still verifies", async () => {
    const secret = ["whsec", "test".repeat(6)].join("_");
    // Everything a re-serialization would change: a 64-bit id, spacing, key order, non-ASCII, a trailing newline.
    const body = '{"z":1,  "id":12345678901234567890,"a":"café 測試 🥭","price":1.10}\n';
    const t = "1730000000";
    const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const local = await serve((res) => res.writeHead(200).end("ok"));

    const answer = await forward(local.url, frame({
      body,
      headers: {
        "stripe-signature": `t=${t},v1=${sig}`,
        "content-type": "application/json",
        "user-agent": "anyhook-forwarder",
        "x-anyhook-original-user-agent": "Stripe/1.0",
        "cf-connecting-ip": "203.0.113.9",
        host: "in.anyhook.net",
        "content-length": "9999",
      },
    }));
    expect(answer.status).toBe(200);

    const { raw, headers } = local.got();
    expect(createHash("sha256").update(raw).digest("hex")).toBe(createHash("sha256").update(body).digest("hex"));
    const [, gotT, gotSig] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(headers["stripe-signature"]))!;
    expect(createHmac("sha256", secret).update(`${gotT}.`).update(raw).digest("hex")).toBe(gotSig);
    expect(headers["user-agent"]).toBe("Stripe/1.0");
    expect(headers["cf-connecting-ip"]).toBeUndefined();
    expect(headers["x-anyhook-original-user-agent"]).toBeUndefined();
    expect(headers.host).toContain("127.0.0.1");
  });

  it("answers with what the server answered, and does not follow a redirect", async () => {
    const local = await serve((res) => res.writeHead(302, { Location: "https://elsewhere.test/", "x-a": "1" }).end());
    const answer = await forward(local.url, frame());
    expect(answer.status).toBe(302);
    expect(answer.headers?.["x-a"]).toBe("1");
  });

  it("caps what it sends back, since the event log keeps only the start", async () => {
    const local = await serve((res) => res.writeHead(200).end("x".repeat(100_000)));
    expect((await forward(local.url, frame())).body.length).toBe(64_000);
  });

  it("never throws: nothing listening is an answer the forwarder can retry", async () => {
    const local = await serve((res) => res.end());
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    const answer = await forward(local.url, frame());
    expect(answer.status).toBe(502);
    expect(answer.body).toBe(`Nothing answered at ${local.url} (ECONNREFUSED).`);
  });

  it("says why when fetch refuses the port itself, rather than a bare 'fetch failed'", async () => {
    expect((await forward("http://127.0.0.1:6000/", frame())).body).toBe("Nothing answered at http://127.0.0.1:6000/ (bad port).");
  });

  it("calls a timeout a timeout", async () => {
    const slow = (async () => { throw Object.assign(new Error("slow"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    const answer = await forward("http://localhost:3000/", frame(), slow);
    expect(answer.status).toBe(504);
    expect(answer.body).toContain("did not answer in time");
  });
});

describe("transient", () => {
  it("keeps trying through a bad network or a bad moment on our side", () => {
    expect(transient(new TypeError("fetch failed"))).toBe(true);
    expect(transient(new AnyHookApiError(0, "Network error"))).toBe(true);
    expect(transient(new AnyHookApiError(429, "slow down"))).toBe(true);
    expect(transient(new AnyHookApiError(503, "down"))).toBe(true);
  });

  it("stops at what only the user can fix", () => {
    for (const status of [401, 403, 404, 409]) expect(transient(new AnyHookApiError(status, "no"))).toBe(false);
    expect(transient(new Error("This account has several apps."))).toBe(false);
  });
});

describe("targetUrl", () => {
  it.each([
    ["3000", "http://localhost:3000/"],
    ["3000/hooks", "http://localhost:3000/hooks"],
    [":3000", "http://localhost:3000/"],
    [":3000/api/webhooks", "http://localhost:3000/api/webhooks"],
    ["localhost:3000/hooks", "http://localhost:3000/hooks"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["http://localhost:3000/a?b=1", "http://localhost:3000/a?b=1"],
    ["https://my.test/hooks", "https://my.test/hooks"],
  ])("%s", (raw, expected) => expect(targetUrl(raw)).toBe(expected));

  it("refuses what is neither", () => expect(() => targetUrl("not a url")).toThrow());
});

describe("localHeaders", () => {
  it("leaves no original user agent as no user agent rather than ours", () => {
    expect(localHeaders({ "user-agent": "anyhook-forwarder", a: "1" })).toEqual({ a: "1" });
  });

  it("keeps AnyHook's own headers: a handler may read them", () => {
    expect(localHeaders({ "x-anyhook-attempt": "2" })).toEqual({ "x-anyhook-attempt": "2" });
  });
});

describe("what it prints", () => {
  const noon = new Date(2026, 10, 4, 12, 0, 0);

  it("names the event from the provider's header, then from the body", () => {
    expect(eventLabel(frame({ headers: { "x-github-event": "push" }, body: '{"type":"x"}' }))).toBe("push");
    expect(eventLabel(frame({ headers: { "x-shopify-topic": "orders/create" } }))).toBe("orders/create");
    expect(eventLabel(frame({ body: '{"type":"invoice.paid"}' }))).toBe("invoice.paid");
    expect(eventLabel(frame({ body: "not json" }))).toBe("");
  });

  it("says what happens next, in the forwarder's own terms", () => {
    const line = (status: number, body = "", headers = {}) =>
      eventLine(frame({ body: '{"type":"invoice.paid"}', headers }), { id: "f1", status, body }, 12, noon);
    expect(line(200)).toBe("12:00:00  200  12 ms  invoice.paid");
    expect(line(400)).toContain("not retried");
    expect(line(301)).toContain("not retried");
    expect(line(500)).toContain("AnyHook retries on its schedule");
    expect(line(429)).toContain("AnyHook retries on its schedule");
    expect(line(200, "", { "x-anyhook-attempt": "3" })).toContain("attempt 3");
    expect(line(502, "Nothing answered at http://localhost:3000/ (ECONNREFUSED).")).toContain("ECONNREFUSED");
  });

  it("tells a keyless user the URL is temporary, how to keep it, and what stopping means", () => {
    const text = banner({
      inbound_url: "https://in.anyhook.net/u/listen",
      connect_url: "wss://x",
      connect_expires_at: 0,
      other_destinations: 2,
      temporary: { expires_at: "2026-11-11T12:00:00.000Z", claim_url: "https://anyhook.net/claim/t" },
    }, "http://localhost:3000/");
    expect(text).toContain("https://in.anyhook.net/u/listen");
    expect(text).toContain("http://localhost:3000/");
    expect(text).toContain("2 other destinations");
    expect(text).toContain("https://anyhook.net/claim/t");
    expect(text).toContain("logged but not forwarded");
  });
});

describe("the saved keyless account", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "anyhook-listen-"));
  const key = ["ak", "test", "k".repeat(8)].join("_");

  it("is readable by its owner only: it holds an API key", () => {
    const path = join(dir(), "nested", "listen.json");
    writeSaved(path, { apiBase: "https://anyhook.net", apiKey: key, appSlug: "listen" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSaved(path, "https://anyhook.net")).toEqual({ apiBase: "https://anyhook.net", apiKey: key, appSlug: "listen" });
  });

  it("is ignored for another API base, or when unreadable", () => {
    const path = join(dir(), "listen.json");
    expect(readSaved(path, "https://anyhook.net")).toBeNull();
    writeSaved(path, { apiBase: "http://localhost:3000", apiKey: key, appSlug: "listen" });
    expect(readSaved(path, "https://anyhook.net")).toBeNull();
  });
});
