// One queue per key: `run(key, fn)` starts fn only after every earlier call
// for the same key has settled. Different keys never wait for each other.
export class KeyedMutex {
  #tails = new Map();

  async run(key, fn) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  isLocked(key) {
    return this.#tails.has(key);
  }
}
