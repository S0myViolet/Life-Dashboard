'use client'

import {
  BOOK_LIMITS,
  BOOK_STATUSES,
  BOOK_STATUS_LABELS,
  type BookStatus,
} from '@personal-home/core'
import { createBookAction, updateBookAction } from '@/app/(app)/learning/actions'
import { FieldError, FormMessage, SubmitButton, fieldAria, useFormAction } from './form-kit'
import { hintClass, inputClass, labelClass, selectClass } from './form-styles'

export interface BookFormValues {
  id: string
  title: string
  author: string | null
  totalPages: number | null
  status: BookStatus
  startedOn: string | null
  finishedOn: string | null
}

/** Add a book (no `book`) or edit one. */
export function BookForm({
  book,
  idPrefix = 'book',
}: {
  book?: BookFormValues
  idPrefix?: string
}) {
  const action = book ? updateBookAction.bind(null, book.id) : createBookAction
  // Resetting after a save also re-syncs an edit form with what was stored (the dates a
  // status change fills in), because the refreshed page updates each field's default.
  const { state, pending, formProps } = useFormAction(action)
  const id = (name: string) => `${idPrefix}-${name}`

  return (
    <form {...formProps} className="space-y-3" aria-label={book ? 'Edit book' : 'Add a book'}>
      <div>
        <label htmlFor={id('title')} className={labelClass}>
          Title
        </label>
        <input
          id={id('title')}
          name="title"
          required
          maxLength={BOOK_LIMITS.titleMax}
          defaultValue={book?.title}
          autoComplete="off"
          className={inputClass}
          {...fieldAria(state, id('title'), 'title')}
        />
        <FieldError state={state} id={id('title')} name="title" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('author')} className={labelClass}>
            Author <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id={id('author')}
            name="author"
            maxLength={BOOK_LIMITS.authorMax}
            defaultValue={book?.author ?? ''}
            autoComplete="off"
            className={inputClass}
            {...fieldAria(state, id('author'), 'author')}
          />
          <FieldError state={state} id={id('author')} name="author" />
        </div>
        <div>
          <label htmlFor={id('totalPages')} className={labelClass}>
            Total pages <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id={id('totalPages')}
            name="totalPages"
            type="number"
            inputMode="numeric"
            min={1}
            max={BOOK_LIMITS.totalPagesMax}
            step={1}
            defaultValue={book?.totalPages ?? ''}
            className={inputClass}
            {...fieldAria(state, id('totalPages'), 'totalPages', id('totalPages-hint'))}
          />
          <FieldError state={state} id={id('totalPages')} name="totalPages" />
          {state.status === 'error' && state.fieldErrors?.totalPages ? null : (
            <p id={id('totalPages-hint')} className={hintClass}>
              Lets page numbers turn into a percentage.
            </p>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={id('status')} className={labelClass}>
            Status
          </label>
          <select
            id={id('status')}
            name="status"
            defaultValue={book?.status ?? 'want'}
            className={selectClass}
          >
            {BOOK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {BOOK_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        {book ? (
          <>
            <div>
              <label htmlFor={id('startedOn')} className={labelClass}>
                Started
              </label>
              <input
                id={id('startedOn')}
                name="startedOn"
                type="date"
                defaultValue={book.startedOn ?? ''}
                className={inputClass}
                {...fieldAria(state, id('startedOn'), 'startedOn')}
              />
              <FieldError state={state} id={id('startedOn')} name="startedOn" />
            </div>
            <div>
              <label htmlFor={id('finishedOn')} className={labelClass}>
                Finished
              </label>
              <input
                id={id('finishedOn')}
                name="finishedOn"
                type="date"
                defaultValue={book.finishedOn ?? ''}
                className={inputClass}
                {...fieldAria(state, id('finishedOn'), 'finishedOn')}
              />
              <FieldError state={state} id={id('finishedOn')} name="finishedOn" />
            </div>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={pending}>{book ? 'Save book' : 'Add book'}</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
