/**
 * A very small IndexedDB wrapper for this device's drafts and not-yet-uploaded recordings.
 *
 * The database name starts with "personal-home" so the /signed-out page deletes it on sign-out.
 * Every call degrades to "unavailable" (null / no-op) instead of throwing: private windows and
 * storage-blocked browsers still let the owner type, and the UI then says "Not saved yet" rather
 * than claiming the text is stored on the device.
 */

export const DRAFTS_DB_NAME = 'personal-home-drafts'
const DB_VERSION = 1
export type DraftStoreName = 'drafts' | 'recordings'

let opening: Promise<IDBDatabase | null> | null = null

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function openDraftsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (opening) return opening
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DRAFTS_DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      // Sign-out deletes this database; let it (and future upgrades) proceed.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      db.onclose = () => {
        opening = null
      }
      resolve(db)
    }
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  }).then((db) => {
    if (!db) opening = null
    return db
  })
  return opening
}

async function withStore<T>(
  name: DraftStoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await openDraftsDb()
  if (!db) return undefined
  try {
    const tx = db.transaction(name, mode)
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    const request = requestToPromise(fn(tx.objectStore(name)))
    const [result] = await Promise.all([request, done])
    return result
  } catch {
    return undefined
  }
}

/** True when the value was durably written. */
export async function idbPut(name: DraftStoreName, value: unknown): Promise<boolean> {
  const db = await openDraftsDb()
  if (!db) return false
  try {
    const tx = db.transaction(name, 'readwrite')
    tx.objectStore(name).put(value)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    return true
  } catch {
    return false
  }
}

export async function idbGet<T>(name: DraftStoreName, key: string): Promise<T | undefined> {
  return (await withStore(name, 'readonly', (s) => s.get(key) as IDBRequest<T>)) ?? undefined
}

export async function idbGetAll<T>(name: DraftStoreName): Promise<T[]> {
  return (await withStore(name, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? []
}

export async function idbDelete(name: DraftStoreName, key: string): Promise<void> {
  await withStore(name, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>)
}
