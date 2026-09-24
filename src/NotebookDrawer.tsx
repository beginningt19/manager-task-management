import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { checkMicrophoneForSpeech, speechRecognitionErrorMessage } from './lib/voiceSupport'
import { applyBulgarianVoiceFormatting } from './lib/bulgarianVoiceFormatting'
import type { Profile } from './types'
import './notebook.css'

type Toast = { tone: 'success' | 'error'; message: string }

type NotebookPage = {
  id: string
  user_id: string
  page_date: string
  page_number: number
  created_at: string
  updated_at: string
}

type NotebookEntry = {
  id: string
  page_id: string
  user_id: string
  body: string
  completed: boolean
  position: number
  created_at: string
  updated_at: string
  edited_at: string | null
  carried_from_entry_id: string | null
  carried_from_date: string | null
  scheduled_time: string | null
  end_time: string | null
  deadline_time: string | null
  source_task_id: string | null
}

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onstart: (() => void) | null
  onresult: ((event: {
    resultIndex: number
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
  }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

const getSpeechRecognitionConstructor = (): SpeechRecognitionConstructor | null => {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null
}

const normalizeSpeechWord = (word: string) =>
  word.toLocaleLowerCase('bg-BG').replace(/^[^а-яa-z0-9]+|[^а-яa-z0-9]+$/giu, '')

const speechWordsMatch = (left: string, right: string) => {
  const a = normalizeSpeechWord(left)
  const b = normalizeSpeechWord(right)
  if (!a || !b) return false
  if (a === b) return true
  return (/^\d+$/.test(a) && b.startsWith(`${a}-`))
    || (/^\d+$/.test(b) && a.startsWith(`${b}-`))
}

const mergeSpeechChunks = (chunks: string[]) => {
  const merged: string[] = []

  chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .forEach((chunk) => {
      const incoming = chunk.split(/\s+/)
      if (!merged.length) {
        merged.push(...incoming)
        return
      }

      const commonLength = Math.min(merged.length, incoming.length)
      let commonPrefix = 0
      while (
        commonPrefix < commonLength
        && speechWordsMatch(merged[commonPrefix], incoming[commonPrefix])
      ) commonPrefix += 1

      const expandedRevision =
        incoming.length >= merged.length
        && commonPrefix >= Math.max(3, merged.length - 2)

      if (expandedRevision) {
        merged.splice(0, merged.length, ...incoming)
        return
      }

      let overlap = 0
      for (let size = Math.min(merged.length, incoming.length); size >= 1; size -= 1) {
        const left = merged.slice(-size)
        const right = incoming.slice(0, size)
        if (left.every((word, index) => speechWordsMatch(word, right[index]))) {
          overlap = size
          break
        }
      }
      merged.push(...incoming.slice(overlap))
    })

  return merged.join(' ')
}

const localDateKey = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const dateFromKey = (key: string) => {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const formatLongDate = (key: string) =>
  new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    weekday: 'long',
  }).format(dateFromKey(key))

const formatCarryDate = (key: string) =>
  new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
  }).format(dateFromKey(key))

const formatTabDate = (key: string) => {
  const date = dateFromKey(key)
  const day = new Intl.DateTimeFormat('bg-BG', { day: '2-digit' }).format(date)
  const month = new Intl.DateTimeFormat('bg-BG', { month: 'short' })
    .format(date)
    .replace('.', '')
    .toLocaleUpperCase('bg-BG')
  return { day, month }
}

const normalizeTime = (value: string | null | undefined) => value ? value.slice(0, 5) : ''

const timeToMinutes = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours * 60) + minutes
}

const minutesToTime = (value: number) => {
  const normalized = Math.max(0, Math.min((24 * 60) - 1, Math.round(value)))
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

const formatFreeDuration = (minutes: number) => {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours && rest) return `${hours} ч ${rest} мин`
  if (hours) return `${hours} ч`
  return `${rest} мин`
}

const sortPages = (items: NotebookPage[]) =>
  [...items].sort((a, b) =>
    b.page_date.localeCompare(a.page_date)
    || a.page_number - b.page_number
  )

const automaticPageForDate = (dayPages: NotebookPage[], allEntries: NotebookEntry[]) => {
  if (!dayPages.length) return null
  const ordered = [...dayPages].sort((a, b) => a.page_number - b.page_number)
  const everyPageHasContent = ordered.every((page) =>
    allEntries.some((entry) => entry.page_id === page.id && entry.body.trim().length > 0),
  )
  return everyPageHasContent ? ordered[ordered.length - 1] : ordered[0]
}

const clampTimeToBounds = (value: string, min?: string, max?: string) => {
  if (!value) return ''
  let minutes = timeToMinutes(value)
  if (min) minutes = Math.max(minutes, timeToMinutes(min))
  if (max) minutes = Math.min(minutes, timeToMinutes(max))
  return minutesToTime(minutes)
}

function NotebookTimeControl({
  value,
  onChange,
  min,
  max,
  label = 'Добави час',
}: {
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const hour = value ? value.slice(0, 2) : ''
  const minute = value ? value.slice(3, 5) : ''

  const chooseHour = (nextHour: string) => {
    if (!nextHour) {
      onChange('')
      return
    }
    onChange(clampTimeToBounds(`${nextHour}:${minute || '00'}`, min, max))
  }

  const chooseMinute = (nextMinute: string) => {
    if (!hour) return
    onChange(clampTimeToBounds(`${hour}:${nextMinute}`, min, max))
  }

  return (
    <div className={`notebook-time-control${value ? ' has-time' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="notebook-time-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span aria-hidden="true">🕒</span>
        <span>{value || label}</span>
        <i aria-hidden="true">⌄</i>
      </button>
      {open && (
        <div className="notebook-time-popover">
          <small>24-ЧАСОВ ФОРМАТ</small>
          <div className="notebook-time-selects">
            <select value={hour} onChange={(event) => chooseHour(event.target.value)} aria-label="Час от 00 до 23">
              <option value="" aria-label="Без избран час">—</option>
              {Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <b>:</b>
            <select value={minute} onChange={(event) => chooseMinute(event.target.value)} aria-label="Минути" disabled={!hour}>
              <option value="" aria-label="Без избрани минути">—</option>
              {Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0')).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
          <div className="notebook-time-popover-actions">
            {value && <button type="button" onClick={() => { onChange(''); setOpen(false) }}>Без час</button>}
            <button type="button" className="done" onClick={() => setOpen(false)}>Готово</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function NotebookDrawer({
  currentUser,
  initialDate,
  initialPageId,
  onClose,
  onResult,
}: {
  currentUser: Profile
  initialDate?: string | null
  initialPageId?: string | null
  onClose: () => void
  onResult: (toast: Toast) => void
}) {
  const [pages, setPages] = useState<NotebookPage[]>([])
  const [entries, setEntries] = useState<NotebookEntry[]>([])
  const [selectedDate, setSelectedDate] = useState(initialDate || localDateKey())
  const [selectedPageId, setSelectedPageId] = useState<string | null>(initialPageId || null)
  const [draft, setDraft] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [showFreeTime, setShowFreeTime] = useState(() => window.localStorage.getItem('notebook-show-free-time') === '1')
  const [gapRange, setGapRange] = useState<{ start: string; end: string } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editingScheduledTime, setEditingScheduledTime] = useState('')
  const [editingEndTime, setEditingEndTime] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [importingTasks, setImportingTasks] = useState(false)
  const [systemTaskSyncEnabled, setSystemTaskSyncEnabled] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceInterim, setVoiceInterim] = useState('')
  const [voiceMessage, setVoiceMessage] = useState('')
  const [pageTurn, setPageTurn] = useState<'forward' | 'backward'>('forward')
  const [pageTurnNonce, setPageTurnNonce] = useState(0)

  const composerRef = useRef<HTMLDivElement | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const voiceBaseRef = useRef('')
  const voiceSegmentsRef = useRef<Map<number, string>>(new Map())
  const voiceLastDraftRef = useRef('')
  const voiceShouldListenRef = useRef(false)
  const voiceStartPendingRef = useRef(false)
  const voiceRestartTimerRef = useRef<number | null>(null)
  const rolloverDateRef = useRef<string | null>(null)
  const systemTaskSyncBusyRef = useRef(false)

  const loadData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    const [pagesResult, entriesResult, taskSyncSettingResult] = await Promise.all([
      supabase
        .from('notebook_pages')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('page_date', { ascending: false })
        .order('page_number', { ascending: true }),
      supabase
        .from('notebook_entries')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase
        .from('notebook_calendar_settings')
        .select('task_sync_enabled')
        .eq('user_id', currentUser.id)
        .maybeSingle(),
    ])

    const error = pagesResult.error || entriesResult.error || taskSyncSettingResult.error
    if (error) {
      onResult({ tone: 'error', message: `Тефтерът не можа да се зареди: ${error.message}` })
      setLoading(false)
      return
    }

    const nextPages = sortPages((pagesResult.data || []) as NotebookPage[])
    const nextEntries = (entriesResult.data || []) as NotebookEntry[]
    setPages(nextPages)
    setEntries(nextEntries)
    setSystemTaskSyncEnabled(Boolean(taskSyncSettingResult.data?.task_sync_enabled))

    setSelectedPageId((current) => {
      const sameDate = nextPages.filter((page) => page.page_date === selectedDate)
      if (current && sameDate.some((page) => page.id === current)) return current
      return automaticPageForDate(sameDate, nextEntries)?.id || null
    })
    setLoading(false)
  }, [currentUser.id, onResult, selectedDate])

  useEffect(() => {
    void loadData()
    const refresh = () => { void loadData(true) }
    const channel = supabase
      .channel(`personal-notebook-${currentUser.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notebook_pages', filter: `user_id=eq.${currentUser.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notebook_entries', filter: `user_id=eq.${currentUser.id}` }, refresh)
      .subscribe()

    return () => {
      voiceShouldListenRef.current = false
      if (voiceRestartTimerRef.current !== null) window.clearTimeout(voiceRestartTimerRef.current)
      recognitionRef.current?.abort()
      recognitionRef.current = null
      void supabase.removeChannel(channel)
    }
  }, [currentUser.id, loadData])

  useEffect(() => {
    if (rolloverDateRef.current === selectedDate) return

    const today = localDateKey()

    // Rollover is only allowed for a selected day that is already in the past.
    // Never call the RPC for today or for any future date.
    if (selectedDate >= today) {
      rolloverDateRef.current = selectedDate
      return
    }

    rolloverDateRef.current = selectedDate
    let cancelled = false

    const rollover = async () => {
      const { data, error } = await supabase.rpc('rollover_notebook_day', { p_date: selectedDate })
      if (cancelled) return

      if (error) {
        rolloverDateRef.current = null
        onResult({ tone: 'error', message: `Незавършените задачи не можаха да се прехвърлят: ${error.message}` })
        return
      }

      if (typeof data === 'number' && data > 0) {
        await loadData(true)
      }
    }

    void rollover()
    return () => { cancelled = true }
  }, [selectedDate, loadData, onResult])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (listening) recognitionRef.current?.stop()
        else if (editingId) setEditingId(null)
        else onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editingId, listening, onClose])

  const pagesForDate = useMemo(
    () => pages.filter((page) => page.page_date === selectedDate).sort((a, b) => a.page_number - b.page_number),
    [pages, selectedDate],
  )

  const selectedPage = useMemo(() => {
    if (selectedPageId) {
      const exact = pagesForDate.find((page) => page.id === selectedPageId)
      if (exact) return exact
    }
    return automaticPageForDate(pagesForDate, entries)
  }, [pagesForDate, selectedPageId, entries])

  const pageEntries = useMemo(
    () => selectedPage
      ? entries
        .filter((entry) => entry.page_id === selectedPage.id)
        .sort((a, b) => {
          const left = normalizeTime(a.scheduled_time)
          const right = normalizeTime(b.scheduled_time)
          const leftDeadlineOnly = Boolean(a.source_task_id) && !left
          const rightDeadlineOnly = Boolean(b.source_task_id) && !right

          if (leftDeadlineOnly !== rightDeadlineOnly) return leftDeadlineOnly ? -1 : 1
          if (!left && right) return -1
          if (left && !right) return 1
          if (left && right && left !== right) return left.localeCompare(right)
          return a.position - b.position || a.created_at.localeCompare(b.created_at)
        })
      : [],
    [entries, selectedPage],
  )

  const visibleDates = useMemo(() => {
    const active = dateFromKey(selectedDate)
    const first = new Date(active)
    first.setDate(active.getDate() - 1)

    return Array.from({ length: 14 }, (_, index) => {
      const date = new Date(first)
      date.setDate(first.getDate() + index)
      return localDateKey(date)
    })
  }, [selectedDate])

  const completedCount = pageEntries.filter((entry) => entry.completed).length
  const activePageNumber = selectedPage?.page_number || 1

  const triggerPageTurn = (direction: 'forward' | 'backward') => {
    setPageTurn(direction)
    setPageTurnNonce((value) => value + 1)
  }

  const chooseDate = (date: string) => {
    if (date !== selectedDate) {
      triggerPageTurn(date > selectedDate ? 'forward' : 'backward')
    }
    setSelectedDate(date)
    const matching = pages.filter((page) => page.page_date === date).sort((a, b) => a.page_number - b.page_number)
    setSelectedPageId(automaticPageForDate(matching, entries)?.id || null)
    setEditingId(null)
    setGapRange(null)
    setScheduledTime('')
    setEndTime('')
  }

  const choosePage = (page: NotebookPage) => {
    if (page.id === selectedPage?.id) return
    triggerPageTurn(page.page_number > activePageNumber ? 'forward' : 'backward')
    setSelectedPageId(page.id)
    setEditingId(null)
    setGapRange(null)
    setScheduledTime('')
    setEndTime('')
  }

  const createPage = async (announce = true) => {
    if (busy) return null
    setBusy(true)
    const { data, error } = await supabase.rpc('create_notebook_page', { p_date: selectedDate })
    setBusy(false)
    if (error) {
      onResult({ tone: 'error', message: `Новата страница не беше създадена: ${error.message}` })
      return null
    }

    const created = (Array.isArray(data) ? data[0] : data) as NotebookPage | null
    if (!created?.id) {
      onResult({ tone: 'error', message: 'Новата страница беше създадена, но не можа да бъде отворена. Обновете тефтера и опитайте отново.' })
      await loadData(true)
      return null
    }

    setPages((current) => sortPages([...current.filter((page) => page.id !== created.id), created]))
    triggerPageTurn('forward')
    setSelectedPageId(created.id)
    if (announce) {
      onResult({ tone: 'success', message: `Добавена е страница ${created.page_number} за ${new Intl.DateTimeFormat('bg-BG').format(dateFromKey(selectedDate))}.` })
    }
    return created
  }

  const addPage = async () => {
    if (pagesForDate.length === 0) {
      const defaultPage = await createPage(false)
      if (!defaultPage) return
    }
    await createPage(true)
  }

  const ensurePage = async () => {
    if (selectedPage) return selectedPage
    return createPage(false)
  }

  const saveDraft = async () => {
    const body = draft.trim()
    if (!body || busy) return

    if (endTime && !scheduledTime) {
      onResult({ tone: 'error', message: 'Изберете начален час преди крайния.' })
      return
    }
    if (scheduledTime && endTime && timeToMinutes(endTime) <= timeToMinutes(scheduledTime)) {
      onResult({ tone: 'error', message: 'Крайният час трябва да бъде след началния.' })
      return
    }

    const page = await ensurePage()
    if (!page) return

    const pageItems = entries.filter((entry) => entry.page_id === page.id)
    const position = pageItems.reduce((max, entry) => Math.max(max, entry.position), -1) + 1

    setBusy(true)
    const { error } = await supabase.from('notebook_entries').insert({
      page_id: page.id,
      user_id: currentUser.id,
      body,
      position,
      completed: false,
      scheduled_time: scheduledTime || null,
      end_time: endTime || null,
    })
    setBusy(false)

    if (error) {
      onResult({ tone: 'error', message: `Записът не беше добавен: ${error.message}` })
      return
    }

    setDraft('')
    setScheduledTime('')
    setEndTime('')
    setGapRange(null)
    setVoiceInterim('')
    setVoiceMessage('')
    await loadData(true)
  }

  const toggleComplete = async (entry: NotebookEntry) => {
    const next = !entry.completed
    setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, completed: next } : item))
    const { error } = await supabase
      .from('notebook_entries')
      .update({ completed: next })
      .eq('id', entry.id)
      .eq('user_id', currentUser.id)

    if (error) {
      setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, completed: entry.completed } : item))
      onResult({ tone: 'error', message: `Отметката не беше записана: ${error.message}` })
    }
  }

  const beginEdit = (entry: NotebookEntry) => {
    setEditingId(entry.id)
    setEditingText(entry.body)
    setEditingScheduledTime(normalizeTime(entry.scheduled_time))
    setEditingEndTime(normalizeTime(entry.end_time))
  }

  const saveEdit = async (entry: NotebookEntry) => {
    const body = editingText.trim()
    if (!body || busy) return

    if (editingEndTime && !editingScheduledTime) {
      onResult({ tone: 'error', message: 'Изберете начален час преди крайния.' })
      return
    }
    if (editingScheduledTime && editingEndTime && timeToMinutes(editingEndTime) <= timeToMinutes(editingScheduledTime)) {
      onResult({ tone: 'error', message: 'Крайният час трябва да бъде след началния.' })
      return
    }

    if (
      body === entry.body.trim()
      && editingScheduledTime === normalizeTime(entry.scheduled_time)
      && editingEndTime === normalizeTime(entry.end_time)
    ) {
      setEditingId(null)
      setEditingText('')
      setEditingScheduledTime('')
      setEditingEndTime('')
      return
    }

    setBusy(true)
    const { error } = await supabase
      .from('notebook_entries')
      .update({
        body,
        scheduled_time: editingScheduledTime || null,
        end_time: editingEndTime || null,
        edited_at: new Date().toISOString(),
      })
      .eq('id', entry.id)
      .eq('user_id', currentUser.id)
    setBusy(false)

    if (error) {
      onResult({ tone: 'error', message: `Редакцията не беше записана: ${error.message}` })
      return
    }

    setEditingId(null)
    setEditingText('')
    setEditingScheduledTime('')
    setEditingEndTime('')
    await loadData(true)
  }

  const syncSystemTasks = useCallback(async (announce = false) => {
    if (systemTaskSyncBusyRef.current) return
    systemTaskSyncBusyRef.current = true
    setImportingTasks(true)

    try {
      const [danielaResult, myAssignmentsResult, notebookPagesResult, notebookEntriesResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('id')
          .eq('display_name', 'Даниела Димитрова')
          .maybeSingle(),
        supabase
          .from('task_assignees')
          .select('task_id')
          .eq('user_id', currentUser.id),
        supabase
          .from('notebook_pages')
          .select('*')
          .eq('user_id', currentUser.id)
          .order('page_date', { ascending: false })
          .order('page_number', { ascending: true }),
        supabase
          .from('notebook_entries')
          .select('id,page_id,source_task_id,position')
          .eq('user_id', currentUser.id),
      ])

      const firstError =
        danielaResult.error
        || myAssignmentsResult.error
        || notebookPagesResult.error
        || notebookEntriesResult.error

      if (firstError) throw firstError

      const notebookPages = (notebookPagesResult.data || []) as NotebookPage[]
      const notebookItems = (notebookEntriesResult.data || []) as Array<{
        id: string
        page_id: string
        source_task_id: string | null
        position: number
      }>

      const linkedByTask = new Map(
        notebookItems
          .filter((entry): entry is typeof entry & { source_task_id: string } => Boolean(entry.source_task_id))
          .map((entry) => [entry.source_task_id, entry]),
      )

      const assignedTaskIds = (myAssignmentsResult.data || []).map((item) => item.task_id)
      const linkedTaskIds = [...linkedByTask.keys()]
      const taskIds = [...new Set([...assignedTaskIds, ...linkedTaskIds])]

      if (!taskIds.length) {
        if (announce) onResult({ tone: 'success', message: 'Няма задачи от системата за синхронизиране с тефтера.' })
        return
      }

      const [tasksResult, assigneesResult] = await Promise.all([
        supabase
          .from('tasks')
          .select('id,created_by,description,due_at,starts_at,ends_at,status')
          .in('id', taskIds),
        supabase
          .from('task_assignees')
          .select('task_id,user_id')
          .in('task_id', taskIds),
      ])

      if (tasksResult.error || assigneesResult.error) {
        throw tasksResult.error || assigneesResult.error
      }

      const assigneesByTask = new Map<string, string[]>()
      ;(assigneesResult.data || []).forEach((assignment) => {
        assigneesByTask.set(
          assignment.task_id,
          [...(assigneesByTask.get(assignment.task_id) || []), assignment.user_id],
        )
      })

      const danielaId = danielaResult.data?.id || null
      const isEligible = (task: {
        id: string
        created_by: string
        description: string
        due_at: string
        starts_at: string | null
        ends_at: string | null
        status: string
      }) => {
        const assignees = assigneesByTask.get(task.id) || []
        if (!assignees.includes(currentUser.id)) return false

        const fromDaniela = Boolean(danielaId) && task.created_by === danielaId
        const personalToSelf =
          task.created_by === currentUser.id
          && assignees.length === 1
          && assignees[0] === currentUser.id

        return fromDaniela || personalToSelf
      }

      // Existing linked tasks are reconciled regardless of their date, so if a
      // due date/time or description changes the notebook entry follows it.
      // New tasks are added when their notebook day is opened.
      const tasksToSync = (tasksResult.data || []).filter((task) => {
        if (!isEligible(task)) return false
        if (linkedByTask.has(task.id)) return true
        if (task.status === 'completed') return false
        const notebookDate = task.starts_at && task.ends_at
          ? localDateKey(new Date(task.starts_at))
          : localDateKey(new Date(task.due_at))
        return notebookDate === selectedDate
      })

      if (!tasksToSync.length) {
        if (announce) onResult({ tone: 'success', message: 'Няма нови или променени задачи за синхронизиране.' })
        return
      }

      const pagesByDate = new Map<string, NotebookPage[]>()
      notebookPages.forEach((page) => {
        pagesByDate.set(page.page_date, [...(pagesByDate.get(page.page_date) || []), page])
      })

      const nextPositionByPage = new Map<string, number>()
      notebookItems.forEach((entry) => {
        nextPositionByPage.set(
          entry.page_id,
          Math.max(nextPositionByPage.get(entry.page_id) ?? -1, entry.position),
        )
      })

      const ensurePageForDate = async (dateKey: string) => {
        const existing = (pagesByDate.get(dateKey) || [])
          .slice()
          .sort((left, right) => left.page_number - right.page_number)[0]

        if (existing) return existing

        const { data, error } = await supabase.rpc('create_notebook_page', { p_date: dateKey })
        if (error) throw error

        const created = (Array.isArray(data) ? data[0] : data) as NotebookPage | null
        if (!created?.id) throw new Error(`Не можа да се създаде страница за ${dateKey}.`)

        pagesByDate.set(dateKey, [created])
        nextPositionByPage.set(created.id, -1)
        return created
      }

      const payload = []
      for (const task of tasksToSync.sort((left, right) => {
        const leftSort = left.starts_at && left.ends_at ? new Date(left.starts_at) : new Date(left.due_at)
        const rightSort = right.starts_at && right.ends_at ? new Date(right.starts_at) : new Date(right.due_at)
        return leftSort.getTime() - rightSort.getTime()
      })) {
        const due = new Date(task.due_at)
        const hasInterval = Boolean(task.starts_at && task.ends_at)
        const start = hasInterval ? new Date(task.starts_at as string) : null
        const end = hasInterval ? new Date(task.ends_at as string) : null
        const dateKey = start ? localDateKey(start) : localDateKey(due)
        const targetPage = await ensurePageForDate(dateKey)
        const linked = linkedByTask.get(task.id)
        const nextPosition = linked?.page_id === targetPage.id
          ? linked.position
          : (nextPositionByPage.get(targetPage.id) ?? -1) + 1

        nextPositionByPage.set(targetPage.id, Math.max(nextPositionByPage.get(targetPage.id) ?? -1, nextPosition))

        payload.push({
          page_id: targetPage.id,
          user_id: currentUser.id,
          body: task.description.trim(),
          position: nextPosition,
          completed: task.status === 'completed',
          scheduled_time: start
            ? `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
            : null,
          end_time: end
            ? `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
            : null,
          deadline_time: start
            ? null
            : `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`,
          source_task_id: task.id,
        })
      }

      const { error } = await supabase
        .from('notebook_entries')
        .upsert(payload, { onConflict: 'user_id,source_task_id' })

      if (error) throw error

      await loadData(true)

      if (announce) {
        onResult({
          tone: 'success',
          message: `Синхронизирани с тефтера: ${payload.length} ${payload.length === 1 ? 'задача' : 'задачи'}.`,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестна грешка'
      onResult({ tone: 'error', message: `Задачите не можаха да се синхронизират с тефтера: ${message}` })
    } finally {
      systemTaskSyncBusyRef.current = false
      setImportingTasks(false)
    }
  }, [currentUser.id, loadData, onResult, selectedDate])

  const toggleSystemTaskSync = async () => {
    if (busy || importingTasks) return

    const next = !systemTaskSyncEnabled
    setImportingTasks(true)

    const { error } = await supabase.rpc('set_notebook_task_sync_enabled', { p_enabled: next })

    if (error) {
      setImportingTasks(false)
      onResult({ tone: 'error', message: `Режимът за задачи в тефтера не беше променен: ${error.message}` })
      return
    }

    setSystemTaskSyncEnabled(next)

    if (next) {
      setImportingTasks(false)
      await syncSystemTasks(true)
    } else {
      // The OFF state means: show only native notebook entries.
      // Imported system tasks are removed atomically by the RPC above.
      setEntries((current) => current.filter((entry) => !entry.source_task_id))
      await loadData(true)
      setImportingTasks(false)
      onResult({
        tone: 'success',
        message: 'Задачите от системата са махнати от тефтера. Остават само тефтерните записи.',
      })
    }
  }

  useEffect(() => {
    if (!systemTaskSyncEnabled) return

    void syncSystemTasks(false)

    let timer: number | null = null
    const queueSync = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void syncSystemTasks(false)
      }, 250)
    }

    const channel = supabase
      .channel(`notebook-system-task-sync-${currentUser.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, queueSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignees' }, queueSync)
      .subscribe()

    return () => {
      if (timer !== null) window.clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [currentUser.id, systemTaskSyncEnabled, syncSystemTasks])

  const toggleFreeTime = () => {
    setShowFreeTime((current) => {
      const next = !current
      window.localStorage.setItem('notebook-show-free-time', next ? '1' : '0')
      if (!next) setGapRange(null)
      return next
    })
  }

  const openGapComposer = (start: string, end: string) => {
    const startMinutes = timeToMinutes(start)
    const endMinutes = timeToMinutes(end)
    if (endMinutes - startMinutes <= 1) return
    setGapRange({ start, end })
    setScheduledTime(minutesToTime(startMinutes + ((endMinutes - startMinutes) / 2)))
    setEndTime('')
    window.requestAnimationFrame(() => composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  const deleteEntry = async (entry: NotebookEntry) => {
    if (busy) return
    if (!window.confirm('Да изтрия ли тази задача от тефтера?')) return

    setBusy(true)
    const { error } = await supabase
      .from('notebook_entries')
      .delete()
      .eq('id', entry.id)
      .eq('user_id', currentUser.id)
    setBusy(false)

    if (error) {
      onResult({ tone: 'error', message: `Задачата не беше изтрита: ${error.message}` })
      return
    }

    if (editingId === entry.id) {
      setEditingId(null)
      setEditingText('')
    }

    setEntries((current) => current.filter((item) => item.id !== entry.id))
    onResult({ tone: 'success', message: 'Задачата е изтрита от тефтера.' })
  }

  const changePage = (direction: -1 | 1) => {
    if (!pagesForDate.length) return
    const currentIndex = selectedPage
      ? pagesForDate.findIndex((page) => page.id === selectedPage.id)
      : pagesForDate.length - 1
    const nextIndex = Math.max(0, Math.min(pagesForDate.length - 1, currentIndex + direction))
    if (nextIndex === currentIndex) return
    triggerPageTurn(direction > 0 ? 'forward' : 'backward')
    setSelectedPageId(pagesForDate[nextIndex].id)
    setEditingId(null)
  }

  const stopVoice = () => {
    voiceShouldListenRef.current = false
    voiceStartPendingRef.current = false
    if (voiceRestartTimerRef.current !== null) {
      window.clearTimeout(voiceRestartTimerRef.current)
      voiceRestartTimerRef.current = null
    }
    recognitionRef.current?.stop()
    setListening(false)
    setVoiceInterim('')
  }

  const startVoice = async () => {
    if (listening) {
      stopVoice()
      return
    }
    if (voiceStartPendingRef.current) return

    const Recognition = getSpeechRecognitionConstructor()
    if (!Recognition) {
      setVoiceMessage('Гласовото въвеждане не се поддържа от този браузър. Използвайте актуален Chrome или Edge.')
      return
    }

    voiceStartPendingRef.current = true
    setVoiceMessage('Проверявам микрофона…')
    const microphone = await checkMicrophoneForSpeech()
    voiceStartPendingRef.current = false

    if (!microphone.ok) {
      setVoiceMessage(microphone.message)
      return
    }

    const recognition = new Recognition()
    recognition.lang = 'bg-BG'
    recognition.continuous = true
    recognition.interimResults = true
    recognitionRef.current = recognition
    voiceShouldListenRef.current = true
    voiceBaseRef.current = draft.trim()
    voiceLastDraftRef.current = draft.trim()
    voiceSegmentsRef.current = new Map()
    setVoiceInterim('')
    setVoiceMessage('Стартиране на диктовката…')

    recognition.onstart = () => {
      if (!voiceShouldListenRef.current) return
      setListening(true)
      setVoiceMessage('')
    }

    recognition.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = result[0]?.transcript?.trim() || ''
        if (!transcript) continue
        if (result.isFinal) voiceSegmentsRef.current.set(index, transcript)
        else interim = transcript
      }

      const mergedFinal = mergeSpeechChunks(
        [...voiceSegmentsRef.current.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => value),
      )
      const combined = [voiceBaseRef.current, mergedFinal].filter(Boolean).join(' ')
      const formatted = applyBulgarianVoiceFormatting(combined)
      voiceLastDraftRef.current = formatted
      setDraft(formatted)
      setVoiceInterim(applyBulgarianVoiceFormatting(interim))
    }

    recognition.onerror = (event) => {
      const message = speechRecognitionErrorMessage(event.error)
      voiceShouldListenRef.current = false
      if (voiceRestartTimerRef.current !== null) {
        window.clearTimeout(voiceRestartTimerRef.current)
        voiceRestartTimerRef.current = null
      }
      setListening(false)
      setVoiceInterim('')
      if (message) setVoiceMessage(message)
    }

    recognition.onend = () => {
      setVoiceInterim('')

      if (!voiceShouldListenRef.current) {
        setListening(false)
        recognitionRef.current = null
        voiceSegmentsRef.current = new Map()
        return
      }

      voiceBaseRef.current = voiceLastDraftRef.current.trim()
      voiceSegmentsRef.current = new Map()
      voiceRestartTimerRef.current = window.setTimeout(() => {
        voiceRestartTimerRef.current = null
        if (!voiceShouldListenRef.current) return
        try {
          recognition.start()
        } catch {
          voiceShouldListenRef.current = false
          recognitionRef.current = null
          setListening(false)
          setVoiceMessage('Диктовката беше прекъсната и не можа да се рестартира. Натиснете „Кажи задачата“ отново.')
        }
      }, 300)
    }

    try {
      recognition.start()
    } catch {
      voiceShouldListenRef.current = false
      recognitionRef.current = null
      setListening(false)
      setVoiceMessage('Микрофонът е достъпен, но разпознаването на реч не можа да бъде стартирано. Опитайте отново в Chrome или Edge.')
    }
  }

  return (
    <div className="notebook-backdrop" role="dialog" aria-modal="true" aria-label="Личен виртуален тефтер">
      <section className="notebook-shell">
        <header className="notebook-topbar">
          <div className="notebook-brand">
            <span className="notebook-brand-icon" aria-hidden="true">✎</span>
            <div>
              <small>ЛИЧЕН ВИРТУАЛЕН ТЕФТЕР</small>
              <strong>{currentUser.display_name}</strong>
            </div>
          </div>

          <button className="notebook-close" type="button" onClick={onClose} aria-label="Затвори тефтера">×</button>
        </header>

        <div className="notebook-desk">
          <div className="notebook-book">
            <div className="notebook-cover-edge" aria-hidden="true" />
            <div className="notebook-paper-stack" aria-hidden="true" />

            {pageTurnNonce > 0 && (
              <div
                key={`page-flip-${pageTurnNonce}`}
                className={`notebook-page-flip notebook-page-flip-${pageTurn}`}
                aria-hidden="true"
              >
                <span className="notebook-page-flip-face notebook-page-flip-front" />
                <span className="notebook-page-flip-face notebook-page-flip-back" />
                <span className="notebook-page-flip-edge" />
              </div>
            )}

            <article
              key={`${selectedDate}:${selectedPage?.id || 'virtual'}:${pageTurnNonce}`}
              className={`notebook-paper notebook-turn-${pageTurn}`}
            >
              <div className="notebook-toolbar">
                <div className="notebook-date-control notebook-date-control-paper">
                  <button type="button" onClick={() => chooseDate(localDateKey())}>Днес</button>
                  <label>
                    <span>Дата</span>
                    <input
                      type="date"
                      value={selectedDate}
                      onChange={(event) => chooseDate(event.target.value || localDateKey())}
                    />
                  </label>
                </div>

                <div className="notebook-toolbar-actions">
                  <button
                    className={systemTaskSyncEnabled ? 'notebook-import-tasks active' : 'notebook-import-tasks'}
                    type="button"
                    onClick={() => void toggleSystemTaskSync()}
                    disabled={busy || importingTasks}
                    aria-pressed={systemTaskSyncEnabled}
                    title={systemTaskSyncEnabled
                      ? 'Изключи автоматичното синхронизиране на задачите с тефтера'
                      : 'Включи задачите от Даниела Димитрова и личните задачи към себе си в тефтера'}
                  >
                    <span className="notebook-toggle-box" aria-hidden="true">{systemTaskSyncEnabled ? '✓' : ''}</span>
                    <span>{importingTasks ? 'Синхронизирам…' : systemTaskSyncEnabled ? 'Задачи в тефтера: Вкл.' : 'Задачи в тефтера: Изкл.'}</span>
                  </button>
                  <button
                    type="button"
                    className={showFreeTime ? 'notebook-free-time-toggle active' : 'notebook-free-time-toggle'}
                    onClick={toggleFreeTime}
                    aria-pressed={showFreeTime}
                  >
                    <span className="notebook-toggle-box" aria-hidden="true">{showFreeTime ? '✓' : ''}</span>
                    <span>Свободно време</span>
                  </button>
                  <button className="notebook-new-page" type="button" onClick={() => void addPage()} disabled={busy}>
                    ＋ Нова страница
                  </button>
                </div>
              </div>

              <div className="notebook-paper-header">
                <div>
                  <span className="notebook-kicker">ДНЕВНИ ЗАПИСКИ</span>
                  <h2>{formatLongDate(selectedDate)}</h2>
                </div>
                <div className="notebook-page-meta">
                  <span>Страница</span>
                  <strong>{activePageNumber} / {Math.max(1, pagesForDate.length)}</strong>
                </div>
              </div>

              <div className="notebook-page-controls">
                <span className="notebook-page-controls-label">Страници за деня</span>
                <div className="notebook-page-nav">
                  <button type="button" onClick={() => changePage(-1)} disabled={!selectedPage || activePageNumber <= 1} aria-label="Предишна страница">‹</button>
                  <div className="notebook-page-dots" aria-label="Страници за деня">
                    {(pagesForDate.length ? pagesForDate : [{ id: 'virtual', page_number: 1 } as NotebookPage]).map((page) => (
                      <button
                        key={page.id}
                        type="button"
                        className={(selectedPage?.id === page.id || (!selectedPage && page.id === 'virtual')) ? 'active' : ''}
                        onClick={() => page.id !== 'virtual' && choosePage(page)}
                        aria-label={`Страница ${page.page_number}`}
                      >
                        {page.page_number}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={() => changePage(1)} disabled={!selectedPage || activePageNumber >= pagesForDate.length} aria-label="Следваща страница">›</button>
                </div>
              </div>

              <div className="notebook-composer" ref={composerRef}>
                <div className="notebook-composer-heading">
                  <div>
                    <strong>Нов запис</strong>
                    <small>Напиши задачата или я кажи на глас.</small>
                  </div>
                  <button
                    type="button"
                    className={listening ? 'notebook-voice listening' : 'notebook-voice'}
                    onClick={startVoice}
                  >
                    <span aria-hidden="true">{listening ? '■' : '🎙'}</span>
                    {listening ? 'Спри' : 'Кажи задачата'}
                  </button>
                </div>
                <textarea
                  className="notebook-draft"
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Запиши какво трябва да свършиш…"
                />
                {listening && (
                  <div className="notebook-listening">
                    <i /> Слушам… {voiceInterim && <em>{voiceInterim}</em>}
                  </div>
                )}
                {voiceMessage && <div className="notebook-voice-message">{voiceMessage}</div>}
                {gapRange && (
                  <div className="notebook-gap-compose-hint">
                    Нова задача между <strong>{gapRange.start}</strong> и <strong>{gapRange.end}</strong>
                    <button type="button" onClick={() => { setGapRange(null); setScheduledTime('') }}>Отказ</button>
                  </div>
                )}
                <div className="notebook-composer-actions">
                  <span>{draft.trim().length ? `${draft.trim().length} знака` : 'Записът ще се разпъва автоматично.'}</span>
                  <div className="notebook-save-controls">
                    <NotebookTimeControl
                      value={scheduledTime}
                      onChange={(value) => {
                        setScheduledTime(value)
                        if (!value) {
                          setEndTime('')
                          setGapRange(null)
                        }
                      }}
                      min={gapRange ? minutesToTime(timeToMinutes(gapRange.start) + 1) : undefined}
                      max={gapRange ? minutesToTime(timeToMinutes(gapRange.end) - 1) : undefined}
                      label="Начален час"
                    />
                    <NotebookTimeControl
                      value={endTime}
                      onChange={setEndTime}
                      min={scheduledTime ? minutesToTime(timeToMinutes(scheduledTime) + 1) : undefined}
                      max={gapRange ? minutesToTime(timeToMinutes(gapRange.end) - 1) : undefined}
                      label="Краен час"
                    />
                    <button type="button" onClick={() => void saveDraft()} disabled={!draft.trim() || busy}>
                      {busy ? 'Записване…' : 'Запиши задачата'}
                    </button>
                  </div>
                </div>
              </div>

              <div className={pageTurnNonce > 0 ? 'notebook-entries notebook-entries-after-turn' : 'notebook-entries'}>
                {loading ? (
                  <div className="notebook-empty">Отварям тефтера…</div>
                ) : pageEntries.length === 0 ? (
                  <div className="notebook-empty">
                    <strong>Празна страница</strong>
                    <p>Първият запис за този ден ще се появи тук.</p>
                  </div>
                ) : pageEntries.map((entry, index) => {
                  const currentTime = normalizeTime(entry.scheduled_time)
                  const currentEndTime = normalizeTime(entry.end_time) || currentTime
                  const deadlineTime = normalizeTime(entry.deadline_time)
                  const nextTime = normalizeTime(pageEntries[index + 1]?.scheduled_time)
                  const gapMinutes = currentTime && currentEndTime && nextTime
                    ? timeToMinutes(nextTime) - timeToMinutes(currentEndTime)
                    : 0

                  return (
                    <Fragment key={entry.id}>
                      <div
                        className={`notebook-entry${entry.source_task_id ? ' imported-task' : ' native-note'}${entry.completed ? ' completed' : ''}${entry.carried_from_date ? ' carried-over' : ''}${currentTime ? ' has-scheduled-time' : ''}`}
                      >
                        <div className="notebook-entry-number">{String(index + 1).padStart(2, '0')}</div>
                        <button
                          type="button"
                          className="notebook-check"
                          onClick={() => void toggleComplete(entry)}
                          aria-pressed={entry.completed}
                          aria-label={entry.completed ? 'Маркирай като незавършено' : 'Маркирай като завършено'}
                        >
                          <span>✓</span>
                        </button>

                        <div className="notebook-entry-body">
                          <div className="notebook-entry-badges">
                            {currentTime && (
                              <span className="notebook-entry-time">
                                <span aria-hidden="true">🕒</span>
                                {currentEndTime && currentEndTime !== currentTime ? `${currentTime}–${currentEndTime}` : currentTime}
                              </span>
                            )}
                            {entry.source_task_id && !currentTime && (
                              <span className="notebook-source-deadline">
                                <span aria-hidden="true">↓</span>
                                Краен срок{deadlineTime ? ` ${deadlineTime}` : ''}
                              </span>
                            )}
                            {entry.carried_from_date && (
                              <div className="notebook-carry-badge" title={`Прехвърлена от ${formatLongDate(entry.carried_from_date)}`}>
                                <span aria-hidden="true">↪</span>
                                <strong>От предния ден</strong>
                                <small>{formatCarryDate(entry.carried_from_date)}</small>
                              </div>
                            )}
                          </div>
                          {editingId === entry.id ? (
                            <div className="notebook-edit-stack">
                              <textarea
                                className="notebook-edit-text"
                                rows={1}
                                value={editingText}
                                onChange={(event) => setEditingText(event.target.value)}
                                autoFocus
                              />
                              <div className="notebook-edit-time-row">
                                <NotebookTimeControl
                                  value={editingScheduledTime}
                                  onChange={(value) => {
                                    setEditingScheduledTime(value)
                                    if (!value) setEditingEndTime('')
                                  }}
                                  label="Начален час"
                                />
                                <NotebookTimeControl
                                  value={editingEndTime}
                                  onChange={setEditingEndTime}
                                  min={editingScheduledTime ? minutesToTime(timeToMinutes(editingScheduledTime) + 1) : undefined}
                                  label="Краен час"
                                />
                              </div>
                            </div>
                          ) : (
                            <p>{entry.body}</p>
                          )}
                          <small>
                            добавено {new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit' }).format(new Date(entry.created_at))}
                            {entry.edited_at ? ' · редактирано' : ''}
                          </small>
                        </div>

                        <div className="notebook-entry-actions">
                          {editingId === entry.id ? (
                            <>
                              <button type="button" className="save" onClick={() => void saveEdit(entry)} disabled={!editingText.trim() || busy}>Запази</button>
                              <button type="button" onClick={() => { setEditingId(null); setEditingScheduledTime(''); setEditingEndTime('') }}>Отказ</button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="notebook-edit-action" onClick={() => beginEdit(entry)} title="Редактирай записа">
                                <span aria-hidden="true">✎</span><span>Редактирай</span>
                              </button>
                              <button
                                type="button"
                                className="notebook-delete-action"
                                onClick={() => void deleteEntry(entry)}
                                title="Изтрий задачата"
                                disabled={busy}
                              >
                                <span aria-hidden="true">⌫</span><span>Изтрий</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {showFreeTime && gapMinutes > 0 && (
                        <button
                          type="button"
                          className="notebook-free-gap"
                          style={{ minHeight: `${Math.max(38, gapMinutes * 0.55)}px` }}
                          onClick={() => openGapComposer(currentEndTime, nextTime)}
                          disabled={gapMinutes <= 1}
                          title={gapMinutes > 1 ? `Добави задача между ${currentEndTime} и ${nextTime}` : undefined}
                        >
                          <span className="notebook-free-gap-line" />
                          <strong>{formatFreeDuration(gapMinutes)} свободно време</strong>
                          {gapMinutes > 1 && <small>Натисни тук, за да добавиш задача в този интервал</small>}
                        </button>
                      )}
                    </Fragment>
                  )
                })}
              </div>

              <footer className="notebook-paper-footer">
                <span>{completedCount} от {pageEntries.length} приключени</span>
                <span className="notebook-footer-mark">MANAGER NOTES · ЯВЛЕНА ИЗТОК</span>
              </footer>
            </article>

            <nav className="notebook-date-tabs" aria-label="Дати в тефтера">
              {visibleDates.map((date) => {
                const tab = formatTabDate(date)
                const count = Math.max(1, pages.filter((page) => page.page_date === date).length)
                return (
                  <button
                    key={date}
                    type="button"
                    className={date === selectedDate ? 'active' : ''}
                    onClick={() => chooseDate(date)}
                    title={formatLongDate(date)}
                  >
                    <strong>{tab.day}</strong>
                    <span>{tab.month}</span>
                    {count > 1 && <small>{count} стр.</small>}
                  </button>
                )
              })}
            </nav>
          </div>
        </div>
      </section>
    </div>
  )
}
