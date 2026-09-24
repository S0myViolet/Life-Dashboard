/** Result of a Settings server action, rendered by the form that submitted it. */
export type SettingsActionState =
  | { status: 'idle' }
  | { status: 'saved'; message: string }
  | {
      status: 'error'
      message: string
      /** Field-level messages, keyed by field name (or slot index for available hours). */
      fieldErrors?: Record<string, string>
    }

export const IDLE_STATE: SettingsActionState = { status: 'idle' }
