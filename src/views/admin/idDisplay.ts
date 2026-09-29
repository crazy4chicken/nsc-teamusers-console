import { h } from 'vue'
import { NButton, NText } from 'naive-ui'

/**
 * Internal identifiers (users, groups, roles, teams, sessions) are long and
 * meaningless to read. The UI shows only a short tail under a plain label and
 * offers a copy button for the full value when another screen asks for it.
 */

/** Short readable form: keeps the last 8 characters. */
export function shortId(id: string | null | undefined): string {
  if (!id) return ''
  return id.length > 8 ? `…${id.slice(-8)}` : id
}

/** Renders the short form with a copy affordance for the full value. */
export function renderIdCell(
  id: string | null | undefined,
  onCopied?: (ok: boolean) => void
) {
  if (!id) return h(NText, { depth: 3 }, { default: () => '—' })
  return h('span', { style: 'display:inline-flex;align-items:center;gap:4px' }, [
    h('code', shortId(id)),
    h(
      NButton,
      {
        size: 'tiny',
        quaternary: true,
        onClick: () => {
          void navigator.clipboard
            .writeText(id)
            .then(() => onCopied?.(true))
            .catch(() => onCopied?.(false))
        }
      },
      { default: () => '复制' }
    )
  ])
}

