/**
 * Options the prototype patches read at call time.
 *
 * pi's components are one shared module, so each prototype is patched once per
 * process. `/reload` re-runs the extension in a fresh module, though, and a
 * patch that captured its options in a closure would keep the old ones — the
 * "already patched" guard would drop the new settings on the floor. Keeping the
 * options in a global slot lets a reload reach the patches already installed.
 */

export interface LiveSlot<T> {
  get(): T;
  set(value: T): void;
}

export function liveSlot<T>(name: string, initial: T): LiveSlot<T> {
  const key = Symbol.for(`pi-toolbox:${name}`);
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  return {
    get: () => store[key] ?? initial,
    set: (value) => {
      store[key] = value;
    },
  };
}

/** `toolbox.enabled`: false turns every installed patch into a pass-through. */
export const toolboxEnabled = liveSlot("enabled", true);
