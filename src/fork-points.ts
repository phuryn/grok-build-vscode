/**
 * ACP replay has reply IDs, but does not reliably distinguish steers from
 * ordinary prompts. Record the end of a settled live turn and match that exact
 * reply on replay. A prompt can edit from the preceding end only when replay
 * places it immediately after that reply.
 */
export class ForkPoints {
  private saved = new Set<string>();
  readonly observed = new Set<string>();
  private adjacentReply: string | undefined;
  private lastReplayUserId: string | undefined;

  load(saved: readonly string[]): void {
    this.saved = new Set(saved);
    this.observed.clear();
    this.adjacentReply = undefined;
    this.lastReplayUserId = undefined;
  }

  reply(messageId: string | undefined, replaying: boolean): string | undefined {
    this.lastReplayUserId = undefined;
    if (!replaying) {
      this.adjacentReply = messageId;
      return undefined;
    }
    this.adjacentReply = messageId && this.saved.has(messageId) ? messageId : undefined;
    if (this.adjacentReply) this.observed.add(this.adjacentReply);
    return this.adjacentReply;
  }

  replayUser(messageId: string | undefined): { startsMessage?: true; forkBefore?: string } {
    const startsMessage = !!messageId && messageId !== this.lastReplayUserId;
    this.lastReplayUserId = messageId;
    const forkBefore = this.adjacentReply;
    this.adjacentReply = undefined;
    return startsMessage ? { startsMessage: true, ...(forkBefore ? { forkBefore } : {}) } : {};
  }

  startPrompt(): string | undefined {
    const previous = this.adjacentReply;
    this.adjacentReply = undefined;
    return previous && this.observed.has(previous) ? previous : undefined;
  }

  settle(completed: boolean): string | undefined {
    if (!completed) this.interrupt();
    if (!this.adjacentReply || this.observed.has(this.adjacentReply)) return undefined;
    this.observed.add(this.adjacentReply);
    return this.adjacentReply;
  }

  interrupt(): void {
    this.adjacentReply = undefined;
    this.lastReplayUserId = undefined;
  }

  compact(): boolean {
    const hadPoints = this.observed.size > 0;
    this.observed.clear();
    this.interrupt();
    return hadPoints;
  }
}
