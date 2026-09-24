import type { ConnectionsFlash } from '@/lib/integrations/flash'

const toneClass: Record<ConnectionsFlash['tone'], string> = {
  positive: 'border-positive/20 bg-positive-soft text-positive',
  caution: 'border-caution/20 bg-caution-soft text-caution',
  danger: 'border-danger/20 bg-danger-soft text-danger',
}

/** Result of the last connect/disconnect, from closed codes only (never echoes URL text). */
export function FlashBanner({ flash }: { flash: ConnectionsFlash }) {
  return (
    <div
      role={flash.tone === 'danger' ? 'alert' : 'status'}
      className={`mb-5 rounded-xl border px-4 py-3 text-sm ${toneClass[flash.tone]}`}
    >
      <p>{flash.message}</p>
      {flash.link ? (
        <p className="mt-1">
          <a
            href={flash.link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
          >
            {flash.link.label}
          </a>
        </p>
      ) : null}
    </div>
  )
}
