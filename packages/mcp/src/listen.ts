/**
 * `npx -y anyhook-mcp listen 3000`: a public webhook URL that forwards to this
 * machine, with no account. The URL is a real AnyHook app, so events are stored,
 * retried and replayable, and the URL survives a restart of this command.
 *
 * Only webhooks. It is not a general tunnel: the sender already has its answer
 * from AnyHook by the time an event gets here, so the local server's response
 * goes to the event log, not back to the sender.
 *
 * The relay's side is ingress/src/listen-relay.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { AnyHookApiError, AnyHookClient, type ListenSession } from "./client";
import { loadConfig, USER_AGENT, type McpConfig } from "./config";

const USAGE = `Usage: npx -y anyhook-mcp listen <port or url> [--app <slug>]

Gives you a public webhook URL and forwards every event to your machine.

  npx -y anyhook-mcp listen 3000
  npx -y anyhook-mcp listen localhost:3000/api/webhooks

No account needed: the first run makes a temporary one, kept in
~/.config/anyhook/listen.json. With ANYHOOK_API_KEY set, it uses that account.

Options:
  -f, --forward-to <url>  Same as the positional argument
      --app <slug>        Which app, when the account has several
  -h, --help              Show this

Needs Node 22 or newer.`;

/** The answer's size the forwarder could use: it keeps 10 KB of a response. */
const MAX_ANSWER_CHARS = 64_000;
/** Past the longest plan timeout, so the forwarder's own clock decides. */
const LOCAL_TIMEOUT_MS = 310_000;
const PING_MS = 30_000;
const DEAD_AFTER_MS = 75_000;
const MAX_BACKOFF_MS = 60_000;
/** ListenRelay closes a socket with this when another `listen` took the app over. */
const REPLACED_CODE = 4001;
/** Set by the forwarder on the hop to the relay (src/lib/listen.ts): the sender's real user agent. */
const ORIGINAL_USER_AGENT_HEADER = "x-anyhook-original-user-agent";

/** "3000", "3000/hooks", ":3000", "localhost:3000/hooks", or a full URL. */
export function targetUrl(raw: string): string {
  const url = /^\d+(\/|$)/.test(raw)
    ? `http://localhost:${raw}`
    : raw.startsWith(":")
      ? `http://localhost${raw}`
      : /^https?:\/\//.test(raw)
        ? raw
        : `http://${raw}`;
  return new URL(url).href;
}

/** Added on the way here (Cloudflare, the hop to the relay), or meaningless on a new connection. */
const NOT_FORWARDED = /^(host|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|expect|cdn-loop|x-real-ip|proxy-.*|cf-.*|x-forwarded-.*)$/i;

/** What the local server should see: what the sender sent, and AnyHook's own X-AnyHook-* headers. */
export function localHeaders(headers: Record<string, string>): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !NOT_FORWARDED.test(name)));
  const { [ORIGINAL_USER_AGENT_HEADER]: original, "user-agent": _hop, ...rest } = kept;
  void _hop;
  return original ? { ...rest, "user-agent": original } : rest;
}

export type EventFrame = { id: string; headers: Record<string, string>; body: string };
export type Answer = { id: string; status: number; headers?: Record<string, string>; body: string };

const NOT_ANSWERED = /^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i;

/** Post one event to the local server. Never throws: no answer is an answer too, and the forwarder retries it. */
export async function forward(target: string, frame: EventFrame, fetchImpl: typeof fetch = fetch): Promise<Answer> {
  try {
    const res = await fetchImpl(target, {
      method: "POST",
      headers: localHeaders(frame.headers),
      body: frame.body,
      redirect: "manual",
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (!NOT_ANSWERED.test(name)) headers[name] = value;
    });
    return { id: frame.id, status: res.status, headers, body: (await res.text()).slice(0, MAX_ANSWER_CHARS) };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    // Not always a code: fetch refuses a few ports outright, with the reason as `cause.message`.
    const { code, message } = (err as { cause?: { code?: string; message?: string } }).cause ?? {};
    const cause = code ?? message ?? (err instanceof Error ? err.message : String(err));
    return {
      id: frame.id,
      status: timedOut ? 504 : 502,
      body: timedOut ? `${target} did not answer in time.` : `Nothing answered at ${target} (${cause}).`,
    };
  }
}

/** The event's name, for the line printed about it. Best effort. */
export function eventLabel(frame: EventFrame): string {
  const named = frame.headers["x-github-event"] ?? frame.headers["x-shopify-topic"];
  if (named) return named;
  try {
    const type = (JSON.parse(frame.body) as { type?: unknown }).type;
    return typeof type === "string" ? type : "";
  } catch {
    return "";
  }
}

/** What happens next, in the words of lib/circuit-breaker's isTerminalStatus. */
function nextStep(status: number): string {
  if (status >= 200 && status < 300) return "";
  const final = (status >= 300 && status < 400) || (status >= 400 && status < 500 && status !== 408 && status !== 429);
  return final ? "not retried" : "AnyHook retries on its schedule";
}

export function eventLine(frame: EventFrame, answer: Answer, ms: number, now: Date = new Date()): string {
  const attempt = Number(frame.headers["x-anyhook-attempt"] ?? 1);
  return [
    now.toTimeString().slice(0, 8),
    String(answer.status),
    `${ms} ms`,
    eventLabel(frame),
    attempt > 1 ? `attempt ${attempt}` : "",
    answer.status >= 500 && answer.status <= 504 && answer.body.startsWith("Nothing answered") ? answer.body : "",
    nextStep(answer.status),
  ].filter(Boolean).join("  ");
}

// ─── The keyless account ─────────────────────────────────────────────────────

type Saved = { apiBase: string; apiKey: string; appSlug: string };

function statePath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "anyhook", "listen.json");
}

export function readSaved(path: string, apiBase: string): Saved | null {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Saved;
    return saved.apiBase === apiBase && saved.apiKey && saved.appSlug ? saved : null;
  } catch {
    return null;
  }
}

/** Holds an API key, so it is readable by its owner only. */
export function writeSaved(path: string, saved: Saved): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

async function quickstart(apiBase: string): Promise<Saved> {
  const res = await fetch(`${apiBase}/api/v1/quickstart`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "listen" }),
  });
  const body = (await res.json().catch(() => ({}))) as { api_key?: string; inbound_url?: string; error?: string };
  if (!res.ok || !body.api_key || !body.inbound_url) {
    throw new AnyHookApiError(res.status, body.error ?? `HTTP ${res.status} from ${apiBase}/api/v1/quickstart`, body);
  }
  return { apiBase, apiKey: body.api_key, appSlug: new URL(body.inbound_url).pathname.split("/").pop()! };
}

async function chooseApp(client: AnyHookClient): Promise<string> {
  const { apps } = await client.listApps();
  if (apps.length === 1) return apps[0].slug;
  if (apps.length === 0) {
    throw new Error("This account has no apps yet. Create one in the dashboard, or unset ANYHOOK_API_KEY to use a temporary URL.");
  }
  throw new Error(`This account has several apps. Pick one with --app: ${apps.map((a) => a.slug).join(", ")}`);
}

const statusOf = (err: unknown) => (err instanceof AnyHookApiError ? err.status : 0);

/** Worth trying again: the network (a bare fetch throws TypeError), a 429 or a 5xx. Anything else is for the user to fix. */
export function transient(err: unknown): boolean {
  if (err instanceof AnyHookApiError) return err.status === 0 || err.status === 429 || err.status >= 500;
  return err instanceof TypeError;
}

/**
 * Find the account and app, and open a session on them. A saved keyless key
 * fails once its account expired (401) and its app moves if a claim had to
 * rename it (404); both are recoverable here, so a stale file never stops a run.
 */
async function open(
  cfg: McpConfig,
  appFlag: string | undefined,
  path: string,
  print: (line: string) => void,
): Promise<{ client: AnyHookClient; slug: string; session: ListenSession }> {
  if (cfg.apiKey) {
    const client = new AnyHookClient(cfg);
    const slug = appFlag ?? (await chooseApp(client));
    return { client, slug, session: await client.listen(slug) };
  }

  const saved = readSaved(path, cfg.apiBase);
  if (saved) {
    const client = new AnyHookClient({ ...cfg, apiKey: saved.apiKey, mode: "remote" });
    const slug = appFlag ?? saved.appSlug;
    try {
      return { client, slug, session: await client.listen(slug) };
    } catch (err) {
      if (statusOf(err) === 404 && !appFlag) {
        const moved = await chooseApp(client);
        writeSaved(path, { ...saved, appSlug: moved });
        return { client, slug: moved, session: await client.listen(moved) };
      }
      if (statusOf(err) !== 401) throw err;
      print("Your temporary URL has expired, so this is a new one.\n");
    }
  }

  const fresh = await quickstart(cfg.apiBase);
  writeSaved(path, fresh);
  const client = new AnyHookClient({ ...cfg, apiKey: fresh.apiKey, mode: "remote" });
  return { client, slug: fresh.appSlug, session: await client.listen(fresh.appSlug) };
}

export function banner(session: ListenSession, target: string): string {
  const lines = [
    `Webhook URL   ${session.inbound_url}`,
    `Forwards to   ${target}`,
  ];
  if (session.other_destinations > 0) {
    const n = session.other_destinations;
    lines.push(`Also sent to  ${n} other destination${n === 1 ? "" : "s"} on this app`);
  }
  if (session.temporary) {
    const until = new Date(session.temporary.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    lines.push("", `This URL is temporary and lasts until ${until}. To keep it: ${session.temporary.claim_url}`);
  }
  lines.push(
    "",
    "Paste the URL into Stripe, GitHub or any webhook sender. Ctrl-C to stop.",
    "While this is stopped, events are logged but not forwarded.",
    "",
  );
  return lines.join("\n");
}

// ─── The connection ──────────────────────────────────────────────────────────

/** The part of the WebSocket global this uses. Node's own takes `headers`, and @types/node 20 has no such global. */
type Socket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", fn: (event: { code?: number }) => void): void;
  addEventListener(type: "message", fn: (event: { data: unknown }) => void): void;
};
type SocketConstructor = new (url: string, init: { headers: Record<string, string> }) => Socket;
const OPEN = 1;

/** One connection, until it ends. Resolves with how it ended. */
function connect(
  Ctor: SocketConstructor,
  url: string,
  target: string,
  print: (line: string) => void,
  onOpen: () => void,
): Promise<{ opened: boolean; replaced: boolean }> {
  return new Promise((resolve) => {
    const socket = new Ctor(url, { headers: { "User-Agent": USER_AGENT } });
    let opened = false;
    let lastPong = Date.now();
    let settled = false;
    const finish = (replaced: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(ping);
      resolve({ opened, replaced });
    };
    const ping = setInterval(() => {
      if (Date.now() - lastPong > DEAD_AFTER_MS) {
        // A laptop waking from sleep: the old socket may take minutes to report it.
        try { socket.close(); } catch { /* already gone */ }
        finish(false);
      } else if (socket.readyState === OPEN) {
        socket.send("ping");
      }
    }, PING_MS);

    socket.addEventListener("open", () => {
      opened = true;
      lastPong = Date.now();
      onOpen();
    });
    socket.addEventListener("close", (event) => finish(event.code === REPLACED_CODE));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("message", (event) => {
      if (event.data === "pong") {
        lastPong = Date.now();
        return;
      }
      let frame: EventFrame;
      try {
        frame = JSON.parse(String(event.data)) as EventFrame;
      } catch {
        return;
      }
      if (!frame.id) return;
      const started = Date.now();
      void forward(target, frame).then((answer) => {
        print(eventLine(frame, answer, Date.now() - started));
        // The forwarder gets its answer from the relay. If the socket went
        // meanwhile, the relay already put the event back on the retry ladder.
        if (socket.readyState === OPEN) socket.send(JSON.stringify(answer));
      });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function explain(err: unknown): string {
  if (err instanceof AnyHookApiError) {
    const body = err.body as { detail?: unknown; fix?: unknown } | undefined;
    return [err.message, body?.detail, body?.fix].filter((part) => typeof part === "string" && part).join(" ");
  }
  return err instanceof Error ? err.message : String(err);
}

export async function runListen(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const print = (line: string) => console.log(line);

  let values: { "forward-to"?: string; app?: string; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "forward-to": { type: "string", short: "f" },
        app: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    print(USAGE);
    return 0;
  }
  const raw = values["forward-to"] ?? positionals[0];
  if (!raw) {
    console.error(USAGE);
    return 1;
  }
  let target: string;
  try {
    target = targetUrl(raw);
  } catch {
    console.error(`Not a port or URL: ${raw}\n\n${USAGE}`);
    return 1;
  }
  const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket as SocketConstructor | undefined;
  if (!Ctor) {
    console.error(`listen needs Node 22 or newer. This is Node ${process.versions.node}.`);
    return 1;
  }

  let opened: Awaited<ReturnType<typeof open>>;
  for (let tries = 1; ; tries++) {
    try {
      opened = await open(loadConfig(env), values.app, statePath(env), print);
      break;
    } catch (err) {
      if (!transient(err)) {
        console.error(explain(err));
        return 1;
      }
      if (tries === 1) print("Could not reach AnyHook. Still trying.");
      await sleep(Math.min(1000 * 2 ** tries, MAX_BACKOFF_MS));
    }
  }
  const { client, slug } = opened;
  let session = opened.session;
  print(banner(session, target));

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  let failures = 0;
  let announced = false;
  for (;;) {
    // A connect URL lasts an hour, so a blip costs no API call and a long
    // outage costs at most one an hour against the plan's daily allowance.
    if (session.connect_expires_at - Date.now() / 1000 < 30) {
      try {
        session = await client.listen(slug);
      } catch (err) {
        if (!transient(err)) {
          console.error(explain(err));
          return 1;
        }
        failures++;
        await sleep(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS));
        continue;
      }
    }

    const ended = await connect(Ctor, session.connect_url, target, print, () => {
      failures = 0;
      if (!announced) print("Connected. Waiting for events.");
      else print("Connected again.");
      announced = true;
    });
    if (ended.replaced) {
      console.error("Another anyhook-mcp listen took over this app, so this one is stopping.");
      return 1;
    }
    if (ended.opened) print("Connection lost. Reconnecting.");
    else if (failures === 0) print("Could not reach AnyHook. Still trying.");
    failures++;
    await sleep(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS));
  }
}
