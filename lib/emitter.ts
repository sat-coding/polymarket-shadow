// Global SSE event emitter — shared across API route handlers in the same process

type Listener = (data: string) => void;

const listeners = new Set<Listener>();

export function addListener(fn: Listener) {
  listeners.add(fn);
}

export function removeListener(fn: Listener) {
  listeners.delete(fn);
}

export function emit(event: string, data: unknown) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const fn of listeners) {
    try { fn(line); } catch { /* ignore dead listeners */ }
  }
}

export function log(message: string) {
  emit('log', { message, ts: Date.now() });
}
