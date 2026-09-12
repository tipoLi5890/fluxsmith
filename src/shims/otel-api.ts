// SPDX-License-Identifier: Apache-2.0
// Stub for the optional `@opentelemetry/api` peer dependency pulled in by a
// provider SDK inside pi-ai. fluxsmith never emits telemetry (zero telemetry
// policy), so every entry point is an inert no-op.
const noopSpan = {
  setAttribute() { return noopSpan; },
  setAttributes() { return noopSpan; },
  setStatus() { return noopSpan; },
  recordException() {},
  end() {},
  isRecording() { return false; },
  addEvent() { return noopSpan; },
  updateName() { return noopSpan; },
  spanContext() { return { traceId: "", spanId: "", traceFlags: 0 }; },
};
const noopTracer = {
  startSpan() { return noopSpan; },
  startActiveSpan(_name: string, ...rest: unknown[]) {
    const fn = rest[rest.length - 1];
    return typeof fn === "function" ? (fn as (s: unknown) => unknown)(noopSpan) : undefined;
  },
};
export const trace = {
  getTracer() { return noopTracer; },
  getActiveSpan() { return undefined; },
  getSpan() { return undefined; },
  setSpan(ctx: unknown) { return ctx; },
};
export const context = {
  active() { return {}; },
  with<T>(_ctx: unknown, fn: () => T) { return fn(); },
};
export const propagation = { inject() {}, extract(ctx: unknown) { return ctx; } };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 } as const;
export default { trace, context, propagation, SpanStatusCode, SpanKind };
