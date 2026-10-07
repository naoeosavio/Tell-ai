import type { StorageLike, StoragePort } from './runtime-api';

/**
 * Wraps an injected `StorageLike` as a `StoragePort`.
 *
 * The storage is always a parameter — this adapter never reads
 * `globalThis.localStorage`, `window`, or any ambient global, so it works in
 * SSR and any browser context when the caller passes the backing store
 * (real localStorage, a test fake, or anything `StorageLike` shaped).
 *
 * @param storage - Injected synchronous key/value store.
 * @returns StoragePort backed by the injected store.
 */
export function createLocalStorageAdapter(storage: StorageLike): StoragePort {
  if (
    storage === undefined ||
    storage === null ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new Error('createLocalStorageAdapter requires a StorageLike { getItem, setItem, removeItem }');
  } else {
    // Valid store — wrapped below.
  }
  const port: StoragePort = {
    async load(key: string): Promise<string> {
      const value = storage.getItem(key);
      if (typeof value === 'string') {
        return value;
      } else {
        return '';
      }
    },
    async save(key: string, value: string): Promise<void> {
      storage.setItem(key, value);
    },
    async clear(key: string): Promise<void> {
      storage.removeItem(key);
    },
    async appendLog(key: string, entry: string): Promise<void> {
      await port.save(key, `${await port.load(key)}${entry}`);
    },
  };
  return port;
}
