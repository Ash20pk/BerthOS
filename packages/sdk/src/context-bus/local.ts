import { EventEmitter } from "node:events";
import type { ContextBusClient } from "./client.js";

/**
 * Phase 1's stand-in for the context bus: an in-process EventEmitter that
 * never leaves the container. Every call is logged at debug level so
 * developers can see what a resident app *would* publish/subscribe to once
 * Phase 2 ships the real Unix-socket/protobuf daemon.
 */
export function createLocalContextBus(): ContextBusClient {
  const emitter = new EventEmitter();

  return {
    async register(info) {
      console.debug(`[context-bus:local] register app="${info.app}" (no-op — Phase 2 will make this real)`);
    },
    async publish(topic, payload) {
      console.debug(`[context-bus:local] publish topic="${topic}"`, payload);
      emitter.emit(topic, payload);
    },
    subscribe(topic, handler) {
      console.debug(`[context-bus:local] subscribe topic="${topic}"`);
      emitter.on(topic, handler);
      return () => emitter.off(topic, handler);
    },
  };
}
