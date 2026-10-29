// Production workerd throws "Illegal invocation" when the global fetch is
// called detached from globalThis (as a stored reference), while node and
// miniflare tolerate it. That gap broke every live provider and model
// call while all tests passed. Every default fetch in this package goes
// through this wrapper so the call always carries the right receiver.
export const boundFetch: typeof fetch = (...args) => globalThis.fetch(...args);
