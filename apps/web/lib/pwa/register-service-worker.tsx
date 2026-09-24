'use client'

import { useEffect } from 'react'

/**
 * Registers the app-shell service worker (lib/pwa/service-worker.js) the way the
 * Next 16 PWA guide does: a bundled worker referenced with
 * `new URL(..., import.meta.url)`, emitted under /_next/static/ and served with
 * `Service-Worker-Allowed: /`, so it can control the whole origin.
 *
 * Production builds only: in `next dev` a worker would outlive hot reloads and
 * make debugging confusing. It never asks for any permission.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker
      .register(new URL('./service-worker.js', import.meta.url), {
        scope: '/',
        updateViaCache: 'none',
      })
      .catch(() => {
        // Offline support is an enhancement; the app works without it.
      })
  }, [])
  return null
}
