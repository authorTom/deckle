import { Fragment, useEffect, useReducer, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  blockActions,
  formatActions,
  headingActions,
  listActions,
  type FormatAction,
} from './formatActions'

/**
 * The button groups in DOM order, with a divider drawn between each pair.
 * Flattened alongside so the roving tabindex can address a button by one index
 * without the render having to count as it goes.
 */
const GROUPS: FormatAction[][] = [
  headingActions,
  formatActions,
  listActions,
  blockActions,
]

/** Index of each group's first button in the flattened order. */
const GROUP_OFFSETS: number[] = GROUPS.reduce<number[]>((acc, _, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + GROUPS[i - 1].length)
  return acc
}, [])

const BUTTON_COUNT = GROUPS.reduce((n, g) => n + g.length, 0)

function ActionButton({
  editor,
  action,
  tabIndex,
  buttonRef,
  onFocus,
}: {
  editor: Editor
  action: FormatAction
  tabIndex: number
  buttonRef: (el: HTMLButtonElement | null) => void
  onFocus: () => void
}) {
  const { Icon, label, run, isActive } = action
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`toolbar-btn${isActive(editor) ? ' active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={isActive(editor)}
      tabIndex={tabIndex}
      onFocus={onFocus}
      // Pressing a format button must not take focus out of the note. With a
      // mouse that only costs a caret blink; on a phone it drops the keyboard,
      // so every tap of Bold would put the keyboard away and bring it back.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onFocus()
        run(editor)
      }}
    >
      <Icon size={18} />
    </button>
  )
}

export default function Toolbar({ editor }: { editor: Editor }) {
  // A toolbar is one tab stop, not thirteen. `role="toolbar"` tells a screen
  // reader the arrow-key model is implemented, so implement it: Tab reaches the
  // group once and lands on whichever control was last used, the arrows move
  // within it, and Tab again goes on to the document. Thirteen tab stops
  // between the chrome and the prose is the difference between a keyboard user
  // reaching the writing and giving up on it.
  const [activeIndex, setActiveIndex] = useState(0)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  // The buttons show what is active at the caret, so redraw whenever the
  // editor's state moves — typing, or just moving the caret into bold text.
  // The toolbar sits outside the editor's pane, so nothing else redraws it.
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    editor.on('transaction', redraw)
    return () => {
      editor.off('transaction', redraw)
    }
  }, [editor])

  const move = (to: number) => {
    const next = (to + BUTTON_COUNT) % BUTTON_COUNT
    setActiveIndex(next)
    buttons.current[next]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        move(activeIndex + 1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        move(activeIndex - 1)
        break
      case 'Home':
        e.preventDefault()
        move(0)
        break
      case 'End':
        e.preventDefault()
        move(BUTTON_COUNT - 1)
        break
    }
  }

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="Formatting"
      onKeyDown={onKeyDown}
    >
      {GROUPS.map((group, g) => (
        <Fragment key={GROUP_OFFSETS[g]}>
          {g > 0 && <span className="toolbar-divider" />}
          {group.map((action, j) => {
            const index = GROUP_OFFSETS[g] + j
            return (
              <ActionButton
                key={action.name}
                editor={editor}
                action={action}
                tabIndex={index === activeIndex ? 0 : -1}
                buttonRef={(el) => {
                  buttons.current[index] = el
                }}
                // A pointer click moves the roving stop too, so returning by
                // keyboard resumes where the hand left off.
                onFocus={() => setActiveIndex(index)}
              />
            )
          })}
        </Fragment>
      ))}
    </div>
  )
}
