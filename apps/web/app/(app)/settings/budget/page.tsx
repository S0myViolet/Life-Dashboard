import { SettingsSubpageHeader } from '@/components/settings/settings-list'
import { Card } from '@/components/ui/card'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Budget and running costs' }

/** Monthly allowances from the product brief (§8). Allowances, not invoices. */
const ALLOWANCES: { item: string; amount: string }[] = [
  { item: 'Supabase, including currency and tax margin', amount: '£30' },
  { item: 'Vercel Hobby', amount: '£0' },
  { item: 'Lunch Flow (banking)', amount: '£5' },
  { item: 'AI and transcription', amount: '£15' },
  { item: 'Domain', amount: '£2' },
  { item: 'Headroom for tax, exchange rates and price changes', amount: '£23' },
]

export default async function BudgetPage() {
  await requireOwner()
  return (
    <>
      <SettingsSubpageHeader
        title="Budget and running costs"
        subtitle="Target: no more than £75 a month, not counting the Claude Code subscription."
      />
      <Card aria-labelledby="allowances-title" className="mb-4">
        <h2 id="allowances-title" className="text-[15px] font-semibold text-ink">
          Monthly allowances
        </h2>
        <table className="mt-3 w-full text-sm">
          <caption className="sr-only">Planned monthly allowances in pounds</caption>
          <tbody className="divide-y divide-line">
            {ALLOWANCES.map((row) => (
              <tr key={row.item}>
                <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-muted">
                  {row.item}
                </th>
                <td className="py-2 text-right tabular-nums text-ink">{row.amount}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
                Ceiling
              </th>
              <td className="py-2 text-right font-medium tabular-nums text-ink">£75</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-ink-faint">
          These are allowances, not invoices. Provider spend caps do not cover every possible
          purchase, so £75 is a target rather than a guarantee. Nothing is bought automatically.
        </p>
      </Card>
      <PlannedSection milestone="Milestone 2">
        <p>
          Measured AI usage and configured recurring costs will be shown here. AI requests reserve a
          conservative cost first; a warning appears at 80% of the £15 AI allowance, and at the cap
          new AI calls stop while sync, planning and your own tools keep working.
        </p>
      </PlannedSection>
    </>
  )
}
