export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * Recursively freezes objects and arrays. Functions are left untouched.
 * Descends into objects that are already frozen (a shallow-frozen parent can still have
 * mutable children) and tolerates cycles.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  freezeInto(value, new WeakSet());
  return value as DeepReadonly<T>;
}

function freezeInto(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeInto((value as Record<PropertyKey, unknown>)[key], seen);
  }
  Object.freeze(value);
}
