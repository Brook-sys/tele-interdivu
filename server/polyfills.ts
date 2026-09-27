// Global shims required by the GramJS bundle when running under Node.js.
// Must be imported before any other module (import evaluation order matters).
const scope = globalThis as any;

// GramJS uses `self` (browser/worker global): crypto.subtle, event listeners
if (typeof scope.self === 'undefined') {
  scope.self = scope;
}

// `PromisedWebSockets` registers an offline listener; no-op in Node
if (typeof scope.addEventListener === 'undefined') {
  scope.addEventListener = () => undefined;
  scope.removeEventListener = () => undefined;
}
