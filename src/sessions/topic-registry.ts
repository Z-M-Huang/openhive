/**
 * Per-key promise queue.  Same topicId → serialized.  Different topicIds → parallel.
 */
export class TopicSessionManager {
  readonly #queues = new Map<string, Promise<unknown>>();

  /**
   * Enqueue work for a topic.  Same-topic work serializes;
   * different topics run in parallel.
   */
  enqueue<T>(topicId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(topicId) ?? Promise.resolve();
    // Run work whether prev resolved or rejected
    const next = prev.then(() => work(), () => work());
    // Store a swallowed copy so a rejection doesn't block the chain
    const safe = next.catch(() => {});
    this.#queues.set(topicId, safe);
    // Clean up when this is still the tail of the chain
    void safe.then(() => {
      if (this.#queues.get(topicId) === safe) this.#queues.delete(topicId);
    });
    return next;
  }

  /** Number of topics with pending work. */
  activeCount(): number {
    return this.#queues.size;
  }
}
