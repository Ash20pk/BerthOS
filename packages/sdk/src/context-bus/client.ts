/**
 * The interface Phase 2's real context-bus daemon client will implement over
 * a Unix socket + protobuf. Phase 1 only ships `local.ts`, an in-process
 * no-op — resident app code written against this interface today needs zero
 * changes when Phase 2 swaps the implementation in runtime.ts.
 */
export interface ContextBusClient {
  register(info: { app: string }): Promise<void>;
  publish(topic: string, payload: unknown): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}
