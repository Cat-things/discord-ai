import { config } from '../config';

/** Tiny FIFO semaphore so a weak machine only runs N local AI requests at once. */
export class Semaphore {
  private active = 0;
  private readonly waiting: { resolve: () => void; onPosition?: (position: number) => void }[] = [];

  constructor(private readonly limit: number) {}

  get queued(): number {
    return this.waiting.length;
  }

  acquire(onPosition?: (position: number) => void): Promise<() => void> {
    const release = () => {
      this.active--;
      const next = this.waiting.shift();
      this.waiting.forEach((w, i) => w.onPosition?.(i + 1));
      if (next) {
        this.active++;
        next.resolve();
      }
    };
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(once(release));
    }
    return new Promise((resolve) => {
      this.waiting.push({ resolve: () => resolve(once(release)), onPosition });
      onPosition?.(this.waiting.length);
    });
  }
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

export const ollamaQueue = new Semaphore(config.ollama.concurrency);
