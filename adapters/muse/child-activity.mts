import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { UnframedViewNotification } from "@muse-code/sdk/dist/src/msp.js";
import { Projection } from "./projection.mjs";

type ViewEvent = { method: string; params: Record<string, any> };

interface ChildView {
  projection: Projection;
  ready?: Promise<void>;
  finishing?: Promise<void>;
  unsubscribing?: Promise<void>;
  subscribed?: boolean;
  buffered?: ViewEvent[];
  liveItems?: Set<string>;
  cursor?: string;
}

/** Follows each child on the parent's MSP connection without attaching a writer. */
export class ChildActivity {
  private readonly children = new Map<string, ChildView>();
  private readonly finished = new Set<string>();
  private closed = false;

  constructor(
    private readonly request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
    private readonly methods: ReadonlySet<string>,
    private readonly emit: (cardId: string, update: SessionUpdate) => void,
    private readonly log: (message: string) => void,
  ) {}

  observe(sessionId: string, cardId: string, terminal: boolean): Promise<void> | undefined {
    if (this.closed || this.finished.has(sessionId)) return;
    let child = this.children.get(sessionId);
    if (!child) {
      child = { projection: new Projection(update => this.emit(cardId, update), this.log) };
      this.children.set(sessionId, child);
      if (!terminal && this.methods.has("view/unsubscribe")) child.ready = this.subscribe(sessionId, child);
    }
    if (terminal) return child.finishing ??= this.finish(sessionId, child);
    return child.ready;
  }

  accept(sessionId: string, method: string, params: Record<string, any>): void {
    const child = this.children.get(sessionId);
    if (!child || !child.subscribed) return;
    const event = { method, params };
    if (child.buffered) child.buffered.push(event);
    else this.project(child, event, !!params.sourceRange);
  }

  private project(child: ChildView, { method, params }: ViewEvent, durable: boolean): void {
    if (durable && typeof params.viewCursor === "string") child.cursor = params.viewCursor;
    if (!method.startsWith("item/")) return;
    // A delta for an item opened before subscription may start midway through
    // its text. Wait for its full snapshot before displaying that item.
    if (child.liveItems) {
      if (method === "item/delta" && !child.liveItems.has(params.itemId)) return;
      if (method === "item/started" && !child.buffered) child.liveItems.add(params.item?.itemId);
      if (method === "item/completed") child.liveItems.delete(params.item?.itemId);
    }
    child.projection.accept(method, params, false);
  }

  private async subscribe(sessionId: string, child: ChildView): Promise<void> {
    child.subscribed = true;
    child.buffered = [];
    try {
      const { viewCursor } = await this.request("view/subscribe", { sessionId });
      // A child may have begun before its id reaches the parent. Backfill
      // through the subscribe head, then release notifications after that head.
      if (typeof viewCursor === "string" && viewCursor) {
        child.liveItems = new Set();
        await this.page(sessionId, child, viewCursor);
      }
    } catch (error) {
      this.log(`Muse child view startup failed: ${String(error)}`);
    } finally {
      const buffered = child.buffered;
      child.buffered = undefined;
      if (!this.closed) for (const event of buffered) this.project(child, event, !!event.params.sourceRange);
    }
  }

  private async page(sessionId: string, child: ChildView, through?: string): Promise<void> {
    if (!this.methods.has("view/page")) return;
    let cursor = child.cursor;
    const cursors = new Set<string>();
    while (!this.closed) {
      const page = await this.request("view/page", { sessionId, direction: "forward", limit: 1000,
        ...(cursor ? { cursor } : {}) });
      if (this.closed) return;
      if (!Array.isArray(page.events)) throw new Error("Muse child view page returned no events");
      for (const event of page.events as UnframedViewNotification[]) {
        if (event.params.sessionId !== sessionId) continue;
        this.project(child, event, true);
        if (event.params.viewCursor === through) return;
      }
      if (!page.nextCursor) return;
      cursor = String(page.nextCursor);
      if (cursors.has(cursor)) throw new Error("Muse child view page cursor repeated");
      cursors.add(cursor);
    }
  }

  private async unsubscribe(sessionId: string, child: ChildView): Promise<void> {
    if (!child.subscribed) return;
    return child.unsubscribing ??= this.request("view/unsubscribe", { sessionId })
      .catch(error => this.log(`Muse child view unsubscribe failed: ${String(error)}`))
      .then(() => { child.subscribed = false; });
  }

  private async finish(sessionId: string, child: ChildView): Promise<void> {
    try {
      await child.ready;
      if (this.closed) return;
      await this.unsubscribe(sessionId, child);
      // The parent's result can arrive ahead of the child's final updates.
      // Read the durable tail after detaching, starting at the last seen cursor.
      await this.page(sessionId, child);
    } catch (error) {
      this.log(`Muse child view history failed: ${String(error)}`);
    } finally {
      this.children.delete(sessionId);
      if (!this.closed) this.finished.add(sessionId);
    }
  }

  close(): void {
    this.closed = true;
    // The SDK flushes queued requests as it closes the transport.
    for (const [sessionId, child] of this.children) void this.unsubscribe(sessionId, child);
    this.children.clear();
    this.finished.clear();
  }
}
