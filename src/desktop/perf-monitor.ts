/**
 * Lightweight performance and event-loop lag monitor for Grok Build Desktop.
 * Measures event loop delays and critical lifecycle durations in development.
 */

export interface PerfMetrics {
  startupMs?: number;
  sessionSwitchMs?: number;
  sendPromptMs?: number;
  eventLoopMaxLagMs: number;
  eventLoopLagCount: number;
}

class PerfMonitor {
  private active = false;
  private maxLagMs = 0;
  private lagCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private logSink: (msg: string) => void = console.log;

  start(logSink?: (msg: string) => void): void {
    if (this.active) return;
    this.active = true;
    if (logSink) this.logSink = logSink;
    this.lastTick = Date.now();

    const checkIntervalMs = 25;
    const warnThresholdMs = 80;

    const tick = () => {
      if (!this.active) return;
      const now = Date.now();
      const elapsed = now - this.lastTick;
      const lag = Math.max(0, elapsed - checkIntervalMs);
      this.lastTick = now;

      if (lag > warnThresholdMs) {
        this.lagCount++;
        if (lag > this.maxLagMs) this.maxLagMs = lag;
        this.logSink(`[PERF:LAG:MAIN] Event loop delay: ${lag}ms (threshold: ${warnThresholdMs}ms)`);
      }

      this.timer = setTimeout(tick, checkIntervalMs);
    };

    this.timer = setTimeout(tick, checkIntervalMs);
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  recordTime<T>(label: string, fn: () => T): T {
    const start = Date.now();
    try {
      return fn();
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed > 40) {
        this.logSink(`[PERF:TIMING] ${label}: ${elapsed}ms`);
      }
    }
  }

  async recordTimeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed > 40) {
        this.logSink(`[PERF:TIMING] ${label}: ${elapsed}ms`);
      }
    }
  }

  getSnapshot(): PerfMetrics {
    return {
      eventLoopMaxLagMs: this.maxLagMs,
      eventLoopLagCount: this.lagCount,
    };
  }
}

export const perfMonitor = new PerfMonitor();
