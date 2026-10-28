export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
