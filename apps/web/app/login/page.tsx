import { buttonClass } from '@/components/ui/button'
import { e2eAuthEnabled } from '@/lib/server/e2e-auth'
import { safeNextPath } from '@/lib/auth/owner-identity'

export const metadata = { title: 'Sign in' }

const ERRORS: Record<string, string> = {
  start_failed: 'Google sign-in could not start. Check the Supabase Google provider settings.',
  missing_code: 'The sign-in response was incomplete. Please try again.',
  exchange_failed: 'The sign-in link expired or was already used. Please try again.',
  no_user: 'Sign-in finished without an account. Please try again.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const next = safeNextPath(params.next)
  const error = params.error ? (ERRORS[params.error] ?? 'Sign-in failed. Please try again.') : null
  const loginHref = e2eAuthEnabled()
    ? `/api/test/login?next=${encodeURIComponent(next)}`
    : `/auth/login?next=${encodeURIComponent(next)}`

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Personal Home</h1>
      <p className="mt-2 text-sm text-ink-muted">
        This is a private dashboard. Only its owner can sign in.
      </p>
      {error ? (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}
      <a href={loginHref} className={buttonClass('primary', 'mt-6 w-full')}>
        Continue with Google
      </a>
    </main>
  )
}
