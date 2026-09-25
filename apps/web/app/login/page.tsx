import { buttonClass } from '@/components/ui/button'
import { coreEnvProblems } from '@/lib/env'
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
  // During setup, say which settings need fixing (names and hints only, never values).
  const problems = e2eAuthEnabled() ? [] : coreEnvProblems()
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
      {problems.length > 0 ? (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-caution/30 bg-caution-soft px-3 py-3 text-sm text-ink"
        >
          <p className="font-medium">Setup isn&rsquo;t finished yet</p>
          <p className="mt-1 text-ink-muted">
            Fix these in Vercel → Settings → Environment Variables, then redeploy:
          </p>
          <ul className="mt-2 space-y-1.5">
            {problems.map((p) => (
              <li key={p.name}>
                <code className="rounded bg-surface px-1 py-0.5 text-xs">{p.name}</code>{' '}
                <span className="text-ink-muted">— {p.hint}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <span aria-disabled="true" className={buttonClass('primary', 'mt-6 w-full opacity-50')}>
          Continue with Google
        </span>
      ) : (
        <a href={loginHref} className={buttonClass('primary', 'mt-6 w-full')}>
          Continue with Google
        </a>
      )}
    </main>
  )
}
