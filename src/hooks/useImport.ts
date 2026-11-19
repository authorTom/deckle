import { useCallback, useMemo, useRef, useState } from 'react'
import type { ImportItem, ImportedNote } from '../fs/library'
import {
  selectionFromDataTransfer,
  selectionFromFiles,
  type ImportSelection,
  type ReadProgress,
} from '../lib/importMarkdown'
import type { ImportOutcome, ImportPending, ImportProgress } from '../components/ImportModal'

type ImportNotes = (
  items: ImportItem[],
  targetFolder?: string,
  onProgress?: (done: number, total: number) => void,
) => Promise<ImportedNote[]>

const FAILED = 'Something went wrong during the import.'

/**
 * Bringing files into the library: the two pickers, a drop onto the tree, and
 * the import dialog's state from reading to done.
 *
 * An import reports itself in a dialog rather than a toast: it has two phases,
 * it can take a while on a folder or an archive, and when it goes wrong the
 * interesting part is *which files* went wrong — none of which fits in a
 * sentence that disappears after two seconds.
 *
 * `onStart` runs as an import begins, so the caller can get the drawers out of
 * the dialog's way.
 */
export function useImport(importNotes: ImportNotes, onStart: () => void) {
  // The file inputs are owned here rather than by the sidebar, so the command
  // palette can open the same pickers.
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Files that have been read and are waiting to be told where to go. Held here
  // rather than in the dialog because they are the import itself, and a dialog
  // that owned them would lose them the moment it unmounted.
  const [selection, setSelection] = useState<ImportSelection | null>(null)

  const openPicker = useCallback((input: HTMLInputElement | null) => {
    if (!input) return
    // Clear first, so picking the same file twice in a row still fires change.
    input.value = ''
    input.click()
  }, [])
  const openImport = useCallback(() => openPicker(fileInput.current), [openPicker])
  const openFolderImport = useCallback(() => openPicker(folderInput.current), [openPicker])

  const onReadProgress = useCallback<ReadProgress>((done, total, label) => {
    setProgress({ phase: 'reading', done, total, label })
  }, [])

  /** The writing half: everything from here on touches the library. */
  const writeSelection = useCallback(
    async (chosen: ImportSelection, targetFolder: string) => {
      setSelection(null)
      try {
        const total = chosen.items.length
        setProgress({ phase: 'writing', done: 0, total })
        // One render per file would cost more than the write does on a large
        // import, and no one can read a counter moving that fast anyway.
        const step = Math.max(1, Math.floor(total / 100))
        const imported = await importNotes(chosen.items, targetFolder, (done, count) => {
          if (done === count || done % step === 0) setProgress({ phase: 'writing', done, total: count })
        })
        setProgress(null)
        setOutcome({
          imported: imported.length,
          renamed: imported.filter((n) => n.renamed).length,
          skipped: chosen.skipped,
          folder: targetFolder,
        })
      } catch (err) {
        setProgress(null)
        setError(err instanceof Error ? err.message : FAILED)
      }
    },
    [importNotes],
  )

  /**
   * Read a selection, then write it.
   *
   * `targetFolder` of `null` means "ask": the files are read, and the dialog
   * offers the library's folders before anything is written. A drop already
   * named its destination by landing on a folder, so it passes one and goes
   * straight through.
   */
  const run = useCallback(
    async (pending: Promise<ImportSelection>, targetFolder: string | null) => {
      setOutcome(null)
      setError(null)
      setSelection(null)
      setProgress({ phase: 'reading', done: 0, total: 0 })
      setOpen(true)
      onStart()

      let read: ImportSelection
      try {
        read = await pending
      } catch (err) {
        setProgress(null)
        setError(err instanceof Error ? err.message : FAILED)
        return
      }
      setProgress(null)

      if (!read.items.length) {
        setOutcome({ imported: 0, renamed: 0, skipped: read.skipped })
        return
      }
      if (targetFolder === null) {
        setSelection(read)
        return
      }
      await writeSelection(read, targetFolder)
    },
    [writeSelection, onStart],
  )

  const importFiles = useCallback(
    (files: FileList | File[]) => void run(selectionFromFiles(files, onReadProgress), null),
    [run, onReadProgress],
  )

  // `webkitGetAsEntry` is only valid while the drop event is being dispatched,
  // so selectionFromDataTransfer reads the entries synchronously before its
  // first await — don't defer this call.
  const dropFiles = useCallback(
    (transfer: DataTransfer, targetFolder: string) =>
      void run(selectionFromDataTransfer(transfer, onReadProgress), targetFolder),
    [run, onReadProgress],
  )

  /** What the destination step is choosing for, in numbers. */
  const pending = useMemo<ImportPending | null>(
    () =>
      selection
        ? {
            notes: selection.items.length,
            skipped: selection.skipped.length,
            nested: selection.items.some((i) => i.path.includes('/')),
          }
        : null,
    [selection],
  )

  /** Import what was read into a folder, from the destination step. */
  const importInto = useCallback(
    (folder: string) => {
      if (selection) void writeSelection(selection, folder)
    },
    [selection, writeSelection],
  )

  const close = useCallback(() => {
    setOpen(false)
    // Cancelling at the destination step throws the read files away — nothing
    // was written, so there is nothing to keep.
    setSelection(null)
  }, [])

  return {
    fileInput,
    folderInput,
    openImport,
    openFolderImport,
    importFiles,
    dropFiles,
    importInto,
    close,
    dialog: { open, progress, pending, outcome, error },
  }
}
