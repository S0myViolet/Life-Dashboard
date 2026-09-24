import Link from 'next/link'

export const metadata = { title: 'Not authorised' }

export default function NotAuthorizedPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">This home is private</h1>
      <p className="mt-2 text-sm text-ink-muted">
        That account is not the owner of this dashboard, so it has been signed out. No data was
        shared.
      </p>
      <Link href="/login" className="mt-6 text-sm text-accent hover:text-accent-strong">
        Sign in with a different account
      </Link>
    </main>
  )
}
