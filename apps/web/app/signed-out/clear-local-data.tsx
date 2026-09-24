'use client'

import { useEffect } from 'react'

/** Logout hygiene: remove Cache Storage entries and IndexedDB databases created by the app. */
export function ClearLocalData() {
  useEffect(() => {
    void (async () => {
      try {
        if ('caches' in window) {
          const keys = await caches.keys()
          await Promise.all(keys.map((k) => caches.delete(k)))
        }
        if ('indexedDB' in window && typeof indexedDB.databases === 'function') {
          const dbs = await indexedDB.databases()
          await Promise.all(
            dbs
              .filter((d) => d.name?.startsWith('personal-home'))
              .map((d) => indexedDB.deleteDatabase(d.name!)),
          )
        }
        localStorage.clear()
        sessionStorage.clear()
      } catch {
        // Best effort; nothing sensitive is kept outside these stores.
      }
    })()
  }, [])
  return null
}
