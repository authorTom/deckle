import { useEffect, useId, useRef, useState } from 'react'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'

export interface MenuItem {
  id: string
  label: string
  Icon: LucideIcon
  hint?: string
  disabled?: boolean
  /** Draws a divider above this item. */
  separated?: boolean
  danger?: boolean
  run: () => void
}

interface OverflowMenuProps {
  items: MenuItem[]
  label?: string
  align?: 'left' | 'right'
}

/**
 * A single button standing in for a row of icons.
 *
 * The chrome used to be a wall of unlabelled icons; folding the rarely-used
 * ones in here trades one click for names people can actually read.
 */
export default function OverflowMenu({
  items,
  label = 'More actions',
  align = 'right',
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const enabled = items.filter((i) => !i.disabled)

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || enabled.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (i + 1) % enabled.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i - 1 + enabled.length) % enabled.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = enabled[index]
      if (item) {
        setOpen(false)
        item.run()
      }
    }
  }

  return (
    <div className="overflow-menu" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`icon-btn${open ? ' active' : ''}`}
        onClick={() => {
          setOpen((o) => !o)
          setIndex(0)
        }}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <MoreHorizontal size={19} />
      </button>

      {/* On a phone the menu rises from the bottom as a sheet, and this is the
          dimmed page above it. Hidden everywhere else. It lives inside the
          wrapper, so the outside-click listener ignores it — the tap is
          handled here instead. */}
      {open && <div className="menu-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}

      {open && (
        <div
          id={menuId}
          className={`menu-popover align-${align}`}
          role="menu"
          aria-label={label}
        >
          {items.map((item) => {
            const { Icon } = item
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-id={item.id}
                disabled={item.disabled}
                className={[
                  'menu-item',
                  item.separated ? 'separated' : '',
                  item.danger ? 'danger' : '',
                  !item.disabled && enabled[index]?.id === item.id ? 'selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseMove={() => {
                  const i = enabled.findIndex((e) => e.id === item.id)
                  if (i >= 0) setIndex(i)
                }}
                onClick={() => {
                  setOpen(false)
                  item.run()
                }}
              >
                <Icon size={16} className="menu-item-icon" />
                <span className="menu-item-label">{item.label}</span>
                {item.hint && <span className="menu-item-hint">{item.hint}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
