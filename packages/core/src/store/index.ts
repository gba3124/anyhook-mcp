/**
 * Event store — abstraction over where webhook events are persisted.
 *
 * The in-memory implementation is the default for the CLI (ephemeral) and
 * MCP server (per-session). SQLite + cloud stores plug in later behind the
 * same interface.
 */

export interface DeliveryAttempt {
  attempt: number;
  targetUrl: string;
  startedAt: Date;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string;
  latencyMs: number;
  error: string | null;
}

export type EventStatus = "received" | "forwarded" | "failed" | "retrying";

export interface WebhookEvent {
  id: string;
  receivedAt: Date;
  source: string | null;
  eventType: string | null;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "utf8" | "base64";
  signature: {
    provider: string;
    valid: boolean;
    reason?: string;
  } | null;
  delivery: DeliveryAttempt[];
  status: EventStatus;
}

export type NewEventInput = Omit<
  WebhookEvent,
  "id" | "receivedAt" | "delivery" | "status"
>;

export interface EventStoreFilter {
  status?: EventStatus;
  source?: string;
  limit?: number;
  since?: Date;
}

export interface EventStore {
  list(filter?: EventStoreFilter): Promise<{
    events: WebhookEvent[];
    nextCursor: string | null;
  }>;
  get(id: string): Promise<WebhookEvent | null>;
  tail(opts?: { filter?: EventStoreFilter; signal?: AbortSignal }): AsyncIterable<WebhookEvent>;
  insert(input: NewEventInput): Promise<WebhookEvent>;
  appendDelivery(id: string, attempt: DeliveryAttempt): Promise<void>;
  setStatus(id: string, status: EventStatus): Promise<void>;
  clear(filter?: EventStoreFilter): Promise<number>;
}

export interface MemoryStoreOptions {
  maxEvents?: number;
}

const DEFAULT_LIMIT = 50;

function matchesFilter(event: WebhookEvent, filter?: EventStoreFilter): boolean {
  if (!filter) return true;
  if (filter.source !== undefined && event.source !== filter.source) return false;
  if (filter.status !== undefined && event.status !== filter.status) return false;
  if (filter.since !== undefined && event.receivedAt < filter.since) return false;
  return true;
}

export function createMemoryStore(options: MemoryStoreOptions = {}): EventStore {
  const events = new Map<string, WebhookEvent>();
  const insertionOrder: string[] = [];
  const listeners = new Set<(event: WebhookEvent) => void>();
  const { maxEvents } = options;

  return {
    async insert(input: NewEventInput): Promise<WebhookEvent> {
      const event: WebhookEvent = {
        id: crypto.randomUUID(),
        receivedAt: new Date(),
        delivery: [],
        status: "received",
        ...input,
      };
      events.set(event.id, event);
      insertionOrder.push(event.id);

      if (maxEvents !== undefined && events.size > maxEvents) {
        const oldestId = insertionOrder.shift();
        if (oldestId) events.delete(oldestId);
      }

      for (const listener of listeners) listener(event);
      return event;
    },

    async get(id: string): Promise<WebhookEvent | null> {
      return events.get(id) ?? null;
    },

    async list(filter?: EventStoreFilter): Promise<{ events: WebhookEvent[]; nextCursor: string | null }> {
      const all = Array.from(events.values())
        .filter((e) => matchesFilter(e, filter))
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

      const limit = filter?.limit ?? DEFAULT_LIMIT;
      const sliced = all.slice(0, limit);
      const nextCursor = all.length > limit ? sliced[sliced.length - 1].id : null;
      return { events: sliced, nextCursor };
    },

    tail({ filter, signal }: { filter?: EventStoreFilter; signal?: AbortSignal } = {}): AsyncIterable<WebhookEvent> {
      async function* iterator() {
        const queue: WebhookEvent[] = [];
        let resolveNext: (() => void) | null = null;
        let stopped = false;

        const stop = () => {
          stopped = true;
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r();
          }
        };

        const listener = (event: WebhookEvent) => {
          if (!matchesFilter(event, filter)) return;
          queue.push(event);
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r();
          }
        };

        listeners.add(listener);
        signal?.addEventListener("abort", stop, { once: true });

        try {
          while (!stopped) {
            if (queue.length > 0) {
              yield queue.shift()!;
            } else {
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });
            }
          }
        } finally {
          listeners.delete(listener);
        }
      }
      return iterator();
    },

    async appendDelivery(id: string, attempt: DeliveryAttempt): Promise<void> {
      const event = events.get(id);
      if (!event) return;
      event.delivery.push(attempt);
    },

    async setStatus(id: string, status: EventStatus): Promise<void> {
      const event = events.get(id);
      if (!event) return;
      event.status = status;
    },

    async clear(filter?: EventStoreFilter): Promise<number> {
      let deleted = 0;
      for (const [id, event] of events.entries()) {
        if (!matchesFilter(event, filter)) continue;
        events.delete(id);
        const orderIdx = insertionOrder.indexOf(id);
        if (orderIdx >= 0) insertionOrder.splice(orderIdx, 1);
        deleted++;
      }
      return deleted;
    },
  };
}
