import Link from 'next/link'
import { ClearLocalData } from './clear-local-data'

export const metadata = { title: 'Signed out' }

export default function SignedOutPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <ClearLocalData />
      <h1 className="text-2xl font-semibold tracking-tight">Signed out</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Cached pages and local drafts on this device have been cleared.
      </p>
      <Link href="/login" className="mt-6 text-sm text-accent hover:text-accent-strong">
        Sign in again
      </Link>
    </main>
  )
}
