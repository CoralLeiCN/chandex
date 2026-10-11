import type { Store } from "../storage/store.ts";
import type {
  DiscoveryOptions,
  WebDiscovery,
  WebResearchClient,
} from "../codex/web-research.ts";
import { webQuery } from "../domain/web-research.ts";
export class WebResearchService {
  private active = new Map<
    string,
    {
      notebook: string;
      controller: AbortController;
      task: Promise<WebDiscovery>;
    }
  >();
  private cancelled = new Map<string, number>();
  private stopping = false;
  constructor(
    readonly store: Pick<Store, "notebook">,
    readonly client: Pick<WebResearchClient, "discover">,
  ) {}
  private key(n: string, key: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        key,
      )
    )
      throw Error("A web search request key is required.");
    return n + ":" + key;
  }
  private prune() {
    for (const [key, expires] of this.cancelled)
      if (expires <= Date.now()) this.cancelled.delete(key);
  }
  search(
    n: string,
    request: DiscoveryOptions & { key: string },
  ): Promise<WebDiscovery> {
    this.store.notebook(n);
    this.prune();
    const key = this.key(n, request.key),
      query = webQuery(request.query);
    if (this.stopping) throw Error("Web research is shutting down.");
    if (this.cancelled.has(key))
      throw Error("This search was cancelled. Start a new search.");
    if (this.active.has(key)) throw Error("This search is already running.");
    if (this.active.size >= 2)
      throw Error("Web research is busy. Wait for a search to finish.");
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;
    const task = Promise.resolve()
      .then(() => {
        if (signal.aborted) throw Error("Web search cancelled.");
        return this.client.discover({ query, model: request.model, signal });
      })
      .then((result) => {
        if (signal.aborted || this.stopping)
          throw Error("Web search cancelled.");
        this.store.notebook(n);
        return result;
      })
      .finally(() => {
        this.active.delete(key);
      });
    this.active.set(key, { notebook: n, controller, task });
    return task;
  }
  cancel(n: string, requestKey: string) {
    this.store.notebook(n);
    this.prune();
    const key = this.key(n, requestKey);
    if (!this.cancelled.has(key) && this.cancelled.size >= 256)
      throw Error(
        "Too many recent search cancellations. Wait before searching again.",
      );
    this.cancelled.set(key, Date.now() + 300000);
    this.active.get(key)?.controller.abort();
  }
  cancelNotebook(n: string) {
    for (const job of this.active.values())
      if (job.notebook === n) job.controller.abort();
  }
  async shutdown() {
    this.stopping = true;
    for (const job of this.active.values()) job.controller.abort();
    await Promise.allSettled([...this.active.values()].map((job) => job.task));
    this.cancelled.clear();
  }
}
