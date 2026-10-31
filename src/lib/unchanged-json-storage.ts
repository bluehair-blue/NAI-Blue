import { createJSONStorage, type PersistStorage, type StateStorage, type StorageValue } from 'zustand/middleware'

/** Zustand partializes on every update, including transient streaming frames.
 * Compare immutable persisted fields before JSON serialization, retaining the
 * original storage's write/error/flush semantics for every actual data change.
 */
export function createUnchangedJSONStorage<S extends object>(getStorage: () => StateStorage): PersistStorage<S> | undefined {
    const storage = createJSONStorage<S>(getStorage)
    if (!storage) return undefined
    const latest = new Map<string, { value: StorageValue<S>; pending: Promise<void> }>()
    return {
        getItem: name => storage.getItem(name),
        removeItem: name => { latest.delete(name); return storage.removeItem(name) },
        setItem(name, value) {
            const previous = latest.get(name)
            const keys = Object.keys(value.state) as (keyof S)[]
            if (previous && previous.value.version === value.version
                && keys.length === Object.keys(previous.value.state).length
                && keys.every(key => Object.is(previous.value.state[key], value.state[key]))) return previous.pending
            const entry = { value, pending: Promise.resolve() }
            // Call the storage immediately: critical data still enters its pending
            // write registry synchronously and flush-before-exit continues to work.
            try {
                entry.pending = Promise.resolve(storage.setItem(name, value)).then(() => undefined).catch(error => {
                    if (latest.get(name) === entry) latest.delete(name)
                    throw error
                })
                latest.set(name, entry)
                return entry.pending
            } catch (error) { latest.delete(name); throw error }
        },
    }
}
