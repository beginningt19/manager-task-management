import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configurationError } from './lib/supabase'
import { checkMicrophoneForSpeech, speechRecognitionErrorMessage } from './lib/voiceSupport'
import { applyBulgarianVoiceFormatting } from './lib/bulgarianVoiceFormatting'
import ChecklistDrawer from './ChecklistDrawer'
import NotebookDrawer from './NotebookDrawer'
import { officeIntroImage } from './officeIntroImage'
import {
  approvalLabels,
  bulgarianDateKey,
  formatDateTime,
  formatBulgarianDateLong,
  formatBulgarianTime,
  initials,
  isOverdue,
  priorityLabels,
  statuses,
  statusLabels,
} from './lib/labels'
import type {
  ActivityEntry,
  Approval,
  ApprovalStatus,
  FileVersion,
  LogicalFile,
  Profile,
  ProgressUpdate,
  TaskAssignee,
  TaskRow,
  TaskStatus,
  TaskView,
} from './types'

type Toast = { tone: 'success' | 'error'; message: string }
type DetailTab = 'progress' | 'files' | 'approvals' | 'activity'
type CreateMode = 'team' | 'personal'

type ManagerVisibilityMode = 'all' | 'own'
type DashboardView = 'list' | 'calendar'
type TaskCategory = 'open' | 'active' | 'approval' | 'overdue' | 'completed'
type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly'
type TaskScheduleMode = 'deadline' | 'interval'
type TaskReminder = {
  id: string
  task_id: string
  created_by: string
  remind_at: string
  sent_at: string | null
  delivery_count: number
  last_error: string | null
}

type NotebookCalendarEntry = {
  id: string
  page_id: string
  page_date: string
  page_number: number
  body: string
  completed: boolean
  position: number
  scheduled_time: string | null
  end_time: string | null
  carried_from_date: string | null
}

const LOW_SPEC_STORAGE_KEY = 'manager-low-spec-mode'
const OFFICE_INTRO_PENDING_KEY = 'manager-office-intro-pending'
const MANAGER_PRODUCTION_ORIGIN = 'https://manager-task-management.pages.dev'
const PASSWORD_RECOVERY_PARAM = 'password-recovery'

const GOVERNOR_TEAM_ASSIGNEE_COLUMNS = [
  ['Биляна Маркова', 'Галина Димитрова', 'Даниел Кръстев', 'Катя Симова', 'Михаил Теофаров', 'Магдалена Калескова'],
  ['Никол Петрова', 'Любомир Рангелов', 'Даниела Димитрова'],
  ['Светослав Симеонов', 'Полина Хаджиева'],
] as const

const readLowSpecPreference = () => {
  try {
    const stored = window.localStorage.getItem(LOW_SPEC_STORAGE_KEY)
    if (stored === '0') return false
    if (stored === '1') return true
    return true
  } catch {
    return true
  }
}

const bulgarianMonths = [
  'Януари',
  'Февруари',
  'Март',
  'Април',
  'Май',
  'Юни',
  'Юли',
  'Август',
  'Септември',
  'Октомври',
  'Ноември',
  'Декември',
]

const bulgarianWeekdays = ['Понеделник', 'Вторник', 'Сряда', 'Четвъртък', 'Петък', 'Събота', 'Неделя']
const bulgarianWeekdayShort = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
const recurrenceLeadLabel = (days: number) => days === 0 ? 'Веднага (0 дни предварително)' : days === 1 ? '1 ден' : `${days} дни`

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onstart: (() => void) | null
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
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

  const numericOrdinalPair =
    (/^\d+$/.test(a) && b.startsWith(`${a}-`))
    || (/^\d+$/.test(b) && a.startsWith(`${b}-`))

  return numericOrdinalPair
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
      ) {
        commonPrefix += 1
      }

      const looksLikeExpandedRevision =
        incoming.length >= merged.length
        && commonPrefix >= Math.max(3, merged.length - 2)

      if (looksLikeExpandedRevision) {
        merged.splice(0, merged.length, ...incoming)
        return
      }

      const maxOverlap = Math.min(merged.length, incoming.length)
      let overlap = 0

      for (let size = maxOverlap; size >= 1; size -= 1) {
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

const taskCategoryLabels: Record<TaskCategory, string> = {
  open: 'Отворени',
  active: 'В процес',
  approval: 'За одобрение',
  overdue: 'Просрочени',
  completed: 'Завършени',
}

const assigneeWorkStatusLabels = {
  new: 'Неприета',
  in_progress: 'В процес',
  completed: 'Завършена',
} as const

const getViewerTaskStatus = (task: TaskView, viewerId?: string | null): TaskStatus => {
  if (task.status === 'completed') return 'completed'
  if (!viewerId) return task.status

  const assignment = task.assignment_states.find((item) => item.user_id === viewerId)
  if (!assignment) return task.status
  if (assignment.work_status === 'new') return 'new'
  if (assignment.work_status === 'completed') return 'completed'
  return task.status
}

const getTaskCategory = (task: TaskView, viewerId?: string | null): TaskCategory => {
  const effectiveStatus = getViewerTaskStatus(task, viewerId)
  if (effectiveStatus === 'completed') return 'completed'
  // Approval is an actionable workflow state and must win over "overdue".
  // Otherwise an overdue task awaiting a decision disappears from the
  // governor's "За одобрение" queue.
  if (effectiveStatus === 'waiting_approval') return 'approval'
  if (isOverdue(task.due_at, effectiveStatus)) return 'overdue'
  if (effectiveStatus === 'new') return 'open'
  return 'active'
}

const entityLabels: Record<string, string> = {
  tasks: 'задачата',
  task_assignees: 'изпълнителите',
  progress_updates: 'напредъка',
  logical_files: 'файловете',
  file_versions: 'версиите',
  approvals: 'одобренията',
  task_reminders: 'напомнянето',
}

const actionLabels: Record<string, string> = {
  insert: 'Добавено',
  update: 'Променено',
  delete: 'Премахнато',
}

const errorText = (value: unknown) =>
  value instanceof Error ? value.message : 'Възникна неочаквана грешка.'

const isJwtFutureError = (value: unknown) => {
  if (!value || typeof value !== 'object') return false
  const error = value as { code?: string; message?: string }
  return error.code === 'PGRST303' && /jwt issued at future/i.test(error.message || '')
}

const needsInitialPassword = (session: Session | null) => Boolean(
  session?.user.user_metadata?.password_initialized === false,
)

const fileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const hexDigest = async (file: File) => {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const safeFileName = (name: string) =>
  name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-140) || 'file'

const localDateKey = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const dateTimeLocalValue = (date: Date) => {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${localDateKey(date)}T${hours}:${minutes}`
}

const defaultReminderForDue = (dueValue: string) => {
  const due = new Date(dueValue)
  const candidate = new Date(due.getTime() - 60 * 60 * 1000)
  const minimum = new Date(Date.now() + 15 * 60 * 1000)
  return dateTimeLocalValue(Number.isNaN(candidate.getTime()) || candidate <= minimum ? minimum : candidate)
}

const validateTaskReminder = (reminderValue: string, _dueValue: string) => {
  const reminder = new Date(reminderValue)
  if (Number.isNaN(reminder.getTime())) return 'Изберете валидна дата и час за напомнянето.'
  if (reminder.getTime() <= Date.now()) return 'Напомнянето трябва да бъде зададено за бъдещ момент.'
  return null
}

const calendarDueDate = (selectedDate: Date) => {
  const dueDate = new Date(selectedDate)
  dueDate.setHours(17, 0, 0, 0)

  if (localDateKey(dueDate) === localDateKey(new Date()) && dueDate.getTime() <= Date.now()) {
    const nextHour = new Date()
    nextHour.setMinutes(0, 0, 0)
    nextHour.setHours(nextHour.getHours() + 1)
    if (localDateKey(nextHour) === localDateKey(dueDate)) return nextHour
    dueDate.setHours(23, 59, 0, 0)
  }

  return dueDate
}

function App() {
  const [lowSpec, setLowSpec] = useState(readLowSpecPreference)
  const lowSpecRef = useRef(lowSpec)
  const [officeIntroPlaying, setOfficeIntroPlaying] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<Toast | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [createDueDate, setCreateDueDate] = useState<Date | null>(null)
  const [calendarChoiceDate, setCalendarChoiceDate] = useState<Date | null>(null)
  const [dashboardView, setDashboardView] = useState<DashboardView>('list')
  const [calendarFullView, setCalendarFullView] = useState(false)
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const today = new Date()
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [adminPasswordOpen, setAdminPasswordOpen] = useState(false)
  const [checklistsOpen, setChecklistsOpen] = useState(false)
  const [notebookOpen, setNotebookOpen] = useState(false)
  const [notebookTarget, setNotebookTarget] = useState<{ date: string; pageId: string } | null>(null)
  const [notebookCalendarEnabled, setNotebookCalendarEnabled] = useState(false)
  const [notebookCalendarBusy, setNotebookCalendarBusy] = useState(false)
  const [notebookCalendarEntries, setNotebookCalendarEntries] = useState<NotebookCalendarEntry[]>([])
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [categoryFocus, setCategoryFocus] = useState<TaskCategory | null>(null)
  const [managerVisibilityMode, setManagerVisibilityMode] = useState<ManagerVisibilityMode>('all')
  const [visibilityBusy, setVisibilityBusy] = useState(false)
  const [connectionEpoch, setConnectionEpoch] = useState(0)
  const resumeSyncRef = useRef<Promise<void> | null>(null)
  const lastResumeAtRef = useRef(0)

  useEffect(() => {
    lowSpecRef.current = lowSpec
    document.documentElement.classList.toggle('low-spec', lowSpec)
    try {
      window.localStorage.setItem(LOW_SPEC_STORAGE_KEY, lowSpec ? '1' : '0')
      if (lowSpec) window.sessionStorage.removeItem(OFFICE_INTRO_PENDING_KEY)
    } catch {
      // Keep the in-memory preference if storage is unavailable.
    }
    if (lowSpec) setOfficeIntroPlaying(false)
  }, [lowSpec])

  useEffect(() => {
    const active = officeIntroPlaying && !lowSpec
    document.documentElement.classList.toggle('office-intro-active', active)
    return () => document.documentElement.classList.remove('office-intro-active')
  }, [officeIntroPlaying, lowSpec])

  const toggleLowSpec = useCallback(() => {
    setLowSpec((current) => !current)
  }, [])

  useEffect(() => {
    const currentModuleSrc = Array.from(document.scripts)
      .find((script) => script.type === 'module' && script.src)?.src
    if (!currentModuleSrc) return

    let checking = false
    let disposed = false

    const checkForNewBuild = async () => {
      if (checking || disposed || document.visibilityState === 'hidden' || !navigator.onLine) return
      checking = true
      try {
        const response = await fetch(`/?__build_check=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        })
        if (!response.ok || disposed) return

        const html = await response.text()
        const parsed = new DOMParser().parseFromString(html, 'text/html')
        const nextSrc = parsed.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src
        if (nextSrc && nextSrc !== currentModuleSrc) {
          window.location.reload()
        }
      } catch {
        // A version check must never interrupt normal app use.
      } finally {
        checking = false
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkForNewBuild()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', checkForNewBuild)
    window.addEventListener('online', checkForNewBuild)
    const intervalId = window.setInterval(() => void checkForNewBuild(), 5 * 60 * 1000)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', checkForNewBuild)
      window.removeEventListener('online', checkForNewBuild)
      window.clearInterval(intervalId)
    }
  }, [])

  const showToast = useCallback((next: Toast) => {
    setToast(next)
    window.setTimeout(() => setToast(null), 4500)
  }, [])

  const loadCore = useCallback(async () => {
    if (!session?.user.id) return
    setLoading(true)

    const [profilesResult, tasksResult, assigneesResult, visibilityResult, notebookCalendarResult] = await Promise.all([
      supabase.from('profiles').select('*').order('display_name'),
      supabase.from('tasks').select('*').order('due_at'),
      supabase.from('task_assignees').select('*'),
      supabase.from('task_visibility_settings').select('manager_mode').eq('id', 'global').maybeSingle(),
      supabase.from('notebook_calendar_settings').select('enabled').eq('user_id', session.user.id).maybeSingle(),
    ])

    const firstError = profilesResult.error || tasksResult.error || assigneesResult.error || visibilityResult.error || notebookCalendarResult.error
    if (firstError) {
      showToast({
        tone: 'error',
        message: isJwtFutureError(firstError)
          ? 'Временна синхронизация на сесията. Изчакайте секунда и опитайте отново.'
          : firstError.message,
      })
      setLoading(false)
      return
    }

    const nextProfiles = (profilesResult.data || []) as Profile[]
    const rawTasks = (tasksResult.data || []) as TaskRow[]
    const nextAssignees = (assigneesResult.data || []) as TaskAssignee[]
    const byId = new Map(nextProfiles.map((person) => [person.id, person]))

    setProfiles(nextProfiles)
    setProfile(byId.get(session.user.id) || null)
    setManagerVisibilityMode((visibilityResult.data?.manager_mode as ManagerVisibilityMode) || 'all')
    setNotebookCalendarEnabled(Boolean(notebookCalendarResult.data?.enabled))
    setTasks(
      rawTasks.map((task) => ({
        ...task,
        creator: byId.get(task.created_by),
        assignees: nextAssignees
          .filter((assignment) => assignment.task_id === task.id)
          .map((assignment) => byId.get(assignment.user_id))
          .filter((person): person is Profile => Boolean(person)),
        assignment_states: nextAssignees.filter((assignment) => assignment.task_id === task.id),
      })),
    )
    setLoading(false)
  }, [session?.user.id, showToast])

  useEffect(() => {
    let cancelled = false

    const initializeSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession()
        if (cancelled) return
        if (error) throw error
        setSession(data.session)
        const recoveryRequested = new URLSearchParams(window.location.search).get(PASSWORD_RECOVERY_PARAM) === '1'
        if (needsInitialPassword(data.session) || (recoveryRequested && data.session)) setPasswordOpen(true)
      } catch (error) {
        if (!cancelled) {
          showToast({ tone: 'error', message: `Сесията не можа да се възстанови: ${errorText(error)}` })
        }
      } finally {
        if (!cancelled) setAuthReady(true)
      }
    }

    void initializeSession()

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      let shouldPlayOfficeIntro = false

      if (event === 'SIGNED_IN' && nextSession) {
        try {
          shouldPlayOfficeIntro = window.sessionStorage.getItem(OFFICE_INTRO_PENDING_KEY) === '1'
          window.sessionStorage.removeItem(OFFICE_INTRO_PENDING_KEY)
        } catch {
          shouldPlayOfficeIntro = false
        }
      }

      if (event === 'SIGNED_OUT') {
        setOfficeIntroPlaying(false)
        try {
          window.sessionStorage.removeItem(OFFICE_INTRO_PENDING_KEY)
        } catch {
          // Session storage may be unavailable in hardened browser modes.
        }
      }

      // Mount the authenticated dashboard first. The intro starts on the next
      // painted frame so its open doorway can never reveal the old login screen.
      setSession(nextSession)
      setAuthReady(true)

      const recoveryRequested = new URLSearchParams(window.location.search).get(PASSWORD_RECOVERY_PARAM) === '1'
      if (event === 'PASSWORD_RECOVERY' || needsInitialPassword(nextSession) || (recoveryRequested && nextSession)) {
        setPasswordOpen(true)
      }

      if (
        event === 'SIGNED_IN'
        && nextSession
        && shouldPlayOfficeIntro
        && !lowSpecRef.current
        && !needsInitialPassword(nextSession)
      ) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => setOfficeIntroPlaying(true))
        })
      }
    })

    return () => {
      cancelled = true
      data.subscription.unsubscribe()
    }
  }, [showToast])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      setProfiles([])
      setTasks([])
      setManagerVisibilityMode('all')
      setNotebookCalendarEnabled(false)
      setNotebookCalendarEntries([])
      setNotebookTarget(null)
      setLoading(false)
      return
    }
    void loadCore()
  }, [session, loadCore])

  useEffect(() => {
    if (!session) return
    const channel = supabase
      .channel(`core-dashboard-${session.user.id}-${connectionEpoch}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, loadCore)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignees' }, loadCore)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'task_visibility_settings' }, loadCore)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notebook_calendar_settings', filter: `user_id=eq.${session.user.id}` }, loadCore)
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [session, loadCore, connectionEpoch])

  useEffect(() => {
    if (!session?.user.id) return

    let disposed = false

    const resume = () => {
      if (document.visibilityState === 'hidden' || !navigator.onLine) return

      const now = Date.now()
      if (resumeSyncRef.current || now - lastResumeAtRef.current < 750) return
      lastResumeAtRef.current = now

      const operation = (async () => {
        try {
          // Mobile browsers can suspend timers and the Realtime socket while the
          // tab/PWA is in the background. Re-read the persisted session first so
          // Supabase can recover/refresh it before any task request is attempted.
          const { data, error } = await supabase.auth.getSession()
          if (error) throw error
          if (disposed) return

          if (!data.session) {
            setSession(null)
            return
          }

          if (data.session.access_token !== session.access_token) {
            setSession(data.session)
          }

          await loadCore()
          if (!disposed) setConnectionEpoch((current) => current + 1)
        } catch (error) {
          if (!disposed) {
            showToast({ tone: 'error', message: `Връзката не можа да се възстанови: ${errorText(error)}` })
          }
        }
      })()

      resumeSyncRef.current = operation
      void operation.finally(() => {
        if (resumeSyncRef.current === operation) resumeSyncRef.current = null
      })
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resume()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('online', resume)
    }
  }, [session?.user.id, session?.access_token, loadCore, showToast])

  const loadNotebookCalendarEntries = useCallback(async () => {
    if (!session?.user.id || !notebookCalendarEnabled || dashboardView !== 'calendar') {
      setNotebookCalendarEntries([])
      return
    }

    const year = calendarCursor.getFullYear()
    const month = calendarCursor.getMonth()
    const firstDayOffset = (new Date(year, month, 1).getDay() + 6) % 7
    const gridStart = new Date(year, month, 1 - firstDayOffset)
    const gridEnd = new Date(gridStart)
    gridEnd.setDate(gridStart.getDate() + 41)
    const startKey = localDateKey(gridStart)
    const endKey = localDateKey(gridEnd)

    const pagesResult = await supabase
      .from('notebook_pages')
      .select('id,page_date,page_number')
      .eq('user_id', session.user.id)
      .gte('page_date', startKey)
      .lte('page_date', endKey)
      .order('page_date', { ascending: true })
      .order('page_number', { ascending: true })

    if (pagesResult.error) {
      showToast({ tone: 'error', message: `Записите от тефтера не можаха да се заредят в календара: ${pagesResult.error.message}` })
      return
    }

    const pages = (pagesResult.data || []) as Array<{ id: string; page_date: string; page_number: number }>
    if (!pages.length) {
      setNotebookCalendarEntries([])
      return
    }

    const entriesResult = await supabase
      .from('notebook_entries')
      .select('id,page_id,body,completed,position,scheduled_time,end_time,carried_from_date')
      .eq('user_id', session.user.id)
      .is('source_task_id', null)
      .in('page_id', pages.map((page) => page.id))
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })

    if (entriesResult.error) {
      showToast({ tone: 'error', message: `Записите от тефтера не можаха да се заредят в календара: ${entriesResult.error.message}` })
      return
    }

    const pageById = new Map(pages.map((page) => [page.id, page]))
    const nextEntries = (entriesResult.data || [])
      .map((entry) => {
        const page = pageById.get(entry.page_id)
        if (!page) return null
        return {
          ...entry,
          page_date: page.page_date,
          page_number: page.page_number,
        } as NotebookCalendarEntry
      })
      .filter((entry): entry is NotebookCalendarEntry => Boolean(entry))
      .sort((a, b) =>
        a.page_date.localeCompare(b.page_date)
        || a.page_number - b.page_number
        || a.position - b.position
      )

    setNotebookCalendarEntries(nextEntries)
  }, [calendarCursor, dashboardView, notebookCalendarEnabled, session?.user.id, showToast])

  useEffect(() => {
    if (!session?.user.id || !notebookCalendarEnabled || dashboardView !== 'calendar') {
      setNotebookCalendarEntries([])
      return
    }

    void loadNotebookCalendarEntries()
    const refresh = () => void loadNotebookCalendarEntries()
    const channel = supabase
      .channel(`notebook-calendar-${session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notebook_pages', filter: `user_id=eq.${session.user.id}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notebook_entries', filter: `user_id=eq.${session.user.id}` }, refresh)
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [dashboardView, loadNotebookCalendarEntries, notebookCalendarEnabled, session?.user.id])

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('bg-BG')
    return tasks.filter((task) => {
      if (needle && !task.description.toLocaleLowerCase('bg-BG').includes(needle)) return false
      if (statusFilter !== 'all' && getViewerTaskStatus(task, session?.user.id) !== statusFilter) return false
      if (assigneeFilter !== 'all' && !task.assignees.some((person) => person.id === assigneeFilter)) return false
      if (overdueOnly && !isOverdue(task.due_at, getViewerTaskStatus(task, session?.user.id))) return false
      return true
    })
  }, [tasks, query, statusFilter, assigneeFilter, overdueOnly, session?.user.id])

  const counts = useMemo(() => {
    const next: Record<TaskCategory, number> = { open: 0, active: 0, approval: 0, overdue: 0, completed: 0 }
    tasks.forEach((task) => {
      next[getTaskCategory(task, session?.user.id)] += 1
    })
    return next
  }, [tasks, session?.user.id])

  const visibleTasks = useMemo(
    () => categoryFocus
      ? filteredTasks.filter((task) => getTaskCategory(task, session?.user.id) === categoryFocus)
      : filteredTasks,
    [categoryFocus, filteredTasks, session?.user.id],
  )
  const visibleListCount = visibleTasks.length
  const canControlManagerVisibility = Boolean(profile && (profile.role === 'admin' || profile.display_role === 'Управител'))
  const canCreateTeamTasks = profile?.display_role === 'Управител'
  const canAdminSetTemporaryPassword = profile?.display_role === 'Управител' || profile?.display_role === 'Модератор'

  useEffect(() => {
    if (!session?.user.id || loading) return
    const params = new URLSearchParams(window.location.search)
    const taskId = params.get('task')
    if (!taskId || !tasks.some((task) => task.id === taskId)) return

    setSelectedTaskId(taskId)
    params.delete('task')
    const nextQuery = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`)
  }, [loading, session?.user.id, tasks])

  const toggleManagerVisibility = async () => {
    if (!canControlManagerVisibility || visibilityBusy) return
    const nextMode: ManagerVisibilityMode = managerVisibilityMode === 'all' ? 'own' : 'all'
    setVisibilityBusy(true)
    const { error } = await supabase.rpc('set_manager_task_visibility', { p_mode: nextMode })
    setVisibilityBusy(false)

    if (error) {
      showToast({ tone: 'error', message: error.message })
      return
    }

    setManagerVisibilityMode(nextMode)
    await loadCore()
    showToast({
      tone: 'success',
      message: nextMode === 'all'
        ? 'Режим 1 е активен: мениджърите виждат всички задачи.'
        : 'Режим 2 е активен: всеки мениджър вижда само задачите, възложени на него.',
    })
  }

  const toggleNotebookCalendar = async () => {
    if (!profile || notebookCalendarBusy) return
    const next = !notebookCalendarEnabled
    setNotebookCalendarBusy(true)
    const { error } = await supabase.rpc('set_notebook_calendar_enabled', { p_enabled: next })
    setNotebookCalendarBusy(false)

    if (error) {
      showToast({ tone: 'error', message: `Режимът „Тефтер в календара“ не беше променен: ${error.message}` })
      return
    }

    setNotebookCalendarEnabled(next)
    if (!next) setNotebookCalendarEntries([])
    showToast({
      tone: 'success',
      message: next
        ? 'Записите от личния тефтер вече се показват в календара.'
        : 'Записите от личния тефтер са скрити от календара.',
    })
  }

  const focusTaskCategory = (category: TaskCategory) => {
    setDashboardView('list')
    setCalendarFullView(false)
    setStatusFilter('all')
    setOverdueOnly(false)
    setCategoryFocus(category)
    window.setTimeout(() => {
      document.querySelector('.task-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  const openCreate = (mode: CreateMode, dueDate: Date | null = null) => {
    setCalendarChoiceDate(null)
    setCreateDueDate(dueDate)
    setCreateMode(mode)
  }
  const openCalendarCreate = (date: Date) => {
    if (!profile) return
    const dueDate = calendarDueDate(date)
    setCreateDueDate(dueDate)
    if (canCreateTeamTasks) setCalendarChoiceDate(dueDate)
    else setCreateMode('personal')
  }

  if (configurationError) return <FatalConfiguration message={configurationError} />
  if (!authReady) return <FullPageLoader />
  if (!session) return <Login lowSpec={lowSpec} onToggleLowSpec={toggleLowSpec} />

  return (
    <>
      {officeIntroPlaying && !lowSpec && (
        <OfficeLoginIntro imageSrc={officeIntroImage} onDone={() => setOfficeIntroPlaying(false)} />
      )}
      {!lowSpec && <AmbientBackground />}
      <div className={`app-shell${officeIntroPlaying && !lowSpec ? ' office-intro-reveal-target' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✓</span>
          <div>
            <strong>Управленски задачи</strong>
            <small>Вътрешна система</small>
          </div>
        </div>
        <div className="account-area">
          <button
            type="button"
            className={`notification-button low-spec-toggle${lowSpec ? ' active' : ''}`}
            onClick={toggleLowSpec}
            title={lowSpec ? 'Изключи Low Spec режима' : 'Включи Low Spec режима за по-ниско натоварване'}
            aria-pressed={lowSpec}
          >
            <span aria-hidden="true">⚡</span>
            <span>{lowSpec ? 'Low Spec: Вкл.' : 'Low Spec'}</span>
          </button>
          {canControlManagerVisibility && (
            <button
              className={`notification-button manager-visibility-toggle ${managerVisibilityMode === 'own' ? 'own-mode' : 'all-mode'}`}
              onClick={() => void toggleManagerVisibility()}
              disabled={visibilityBusy}
              title={managerVisibilityMode === 'all'
                ? 'Режим 1: мениджърите виждат всички задачи. Натиснете за режим 2.'
                : 'Режим 2: мениджърите виждат само своите задачи. Натиснете за режим 1.'}
              aria-label="Превключи видимостта на задачите за мениджърите"
            >
              <i className="visibility-mode-indicator" aria-hidden="true" />
              <span>{visibilityBusy ? 'Промяна…' : managerVisibilityMode === 'all' ? 'Мениджъри: всички' : 'Мениджъри: само свои'}</span>
            </button>
          )}
          <button className={`notification-button checklist-launch${dashboardView === 'calendar' ? ' active' : ''}`} onClick={() => setDashboardView('calendar')} title="Отвори календара">◷<span>Календар</span></button>
          <button className="notification-button checklist-launch notebook-launch" onClick={() => { setNotebookTarget(null); setNotebookOpen(true) }} title="Отвори личния тефтер">✎<span>Тефтер</span></button>
          <PushButton userId={session.user.id} onResult={showToast} />
          {canAdminSetTemporaryPassword && (
            <button className="notification-button" onClick={() => setAdminPasswordOpen(true)} title="Задай временна парола на потребител">⚿<span>Временна парола</span></button>
          )}
          <button className="notification-button" onClick={() => setPasswordOpen(true)} title="Смени паролата">⌘<span>Парола</span></button>
          <span className="avatar" aria-hidden="true">{initials(profile?.display_name || session.user.email || 'А')}</span>
          <div className="account-copy">
            <strong>{profile?.display_name || session.user.email}</strong>
            <small>{profile?.display_role || (profile?.role === 'manager' ? 'Мениджър' : 'Модератор')}</small>
          </div>
          <button className="icon-button" onClick={() => void supabase.auth.signOut()} aria-label="Изход" title="Изход">↗</button>
        </div>
      </header>

      <main className={dashboardView === 'calendar' && calendarFullView ? 'calendar-full-mode' : undefined}>
        <section className="page-heading dashboard-hero">
          <div className="hero-copy">
            <p className="eyebrow">Общ преглед</p>
            <h1>Задачи на екипа</h1>
            <span className="hero-live"><i /> Синхронизирано в реално време</span>
          </div>
          {profile && (
            <div className="page-actions">
              <button className="secondary-button" onClick={() => openCreate('personal')} title="Създай лична задача"><span>＋</span> Лична задача</button>
              {canCreateTeamTasks && (
                <button className="primary-button" onClick={() => openCreate('team')} title="Създай екипна задача"><span>＋</span> Екипна задача</button>
              )}
            </div>
          )}
          {!lowSpec && (
            <div className="hero-art manager-hero-art" aria-hidden="true">
              <span className="hero-signal signal-a" />
              <span className="hero-signal signal-b" />
              <span className="hero-signal signal-c" />
              <span className="hero-data-bar bar-a" />
              <span className="hero-data-bar bar-b" />
              <span className="hero-data-bar bar-c" />
              <span className="hero-data-bar bar-d" />
            </div>
          )}
        </section>

        <section className="stat-grid" aria-label="Филтри по състояние на задачите">
          <StatCard label="Отворени" value={counts.open} tone="teal" icon="□" active={categoryFocus === 'open'} onClick={() => focusTaskCategory('open')} />
          <StatCard label="В процес" value={counts.active} tone="blue" icon="↻" active={categoryFocus === 'active'} onClick={() => focusTaskCategory('active')} />
          <StatCard label="За одобрение" value={counts.approval} tone="amber" icon="✓" active={categoryFocus === 'approval'} onClick={() => focusTaskCategory('approval')} />
          <StatCard label="Просрочени" value={counts.overdue} tone="red" icon="!" active={categoryFocus === 'overdue'} onClick={() => focusTaskCategory('overdue')} />
          <StatCard label="Завършени" value={counts.completed} tone="green" icon="✓" active={categoryFocus === 'completed'} onClick={() => focusTaskCategory('completed')} />
        </section>

        <section className={`panel task-panel${dashboardView === 'calendar' && calendarFullView ? ' calendar-full-panel' : ''}`}>
          <div className="filters">
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Търси в описанието…" />
            </label>
            <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as 'all' | TaskStatus); setCategoryFocus(null) }} aria-label="Статус">
              <option value="all">Всички статуси</option>
              {statuses.filter((status) => status !== 'completed').map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
            </select>
            <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} aria-label="Изпълнител">
              <option value="all">Всички изпълнители</option>
              {profiles.filter((person) => person.is_active).map((person) => (
                <option key={person.id} value={person.id}>{person.display_name}</option>
              ))}
            </select>
            <label className="check-filter">
              <input type="checkbox" checked={overdueOnly} onChange={(event) => { setOverdueOnly(event.target.checked); setCategoryFocus(null) }} />
              Само просрочени
            </label>
          </div>

          <div className="panel-heading">
            <h2>{categoryFocus ? taskCategoryLabels[categoryFocus] : 'Задачи'} <span>{visibleListCount}</span></h2>
            <div className="panel-actions">
              <div className="view-switch" aria-label="Изглед на задачите">
                <button className={dashboardView === 'list' ? 'active' : ''} onClick={() => { setDashboardView('list'); setCalendarFullView(false) }} aria-pressed={dashboardView === 'list'}>Списък</button>
              </div>
              <button className="text-button" onClick={() => void loadCore()}>Обнови</button>
            </div>
          </div>

          {loading ? (
            <InlineLoader />
          ) : dashboardView === 'calendar' ? (
            <CalendarView
              tasks={visibleTasks}
              notebookEntries={notebookCalendarEntries}
              notebookEnabled={notebookCalendarEnabled}
              notebookBusy={notebookCalendarBusy}
              cursor={calendarCursor}
              onCursorChange={setCalendarCursor}
              onOpen={(taskId) => setSelectedTaskId(taskId)}
              onOpenNotebook={(entry) => {
                setNotebookTarget({ date: entry.page_date, pageId: entry.page_id })
                setNotebookOpen(true)
              }}
              onToggleNotebook={() => void toggleNotebookCalendar()}
              fullView={calendarFullView}
              onToggleFullView={() => setCalendarFullView((current) => !current)}
              onCreate={openCalendarCreate}
            />
          ) : visibleListCount === 0 ? (
            <div className="empty-state">
              <span>✓</span>
              <h3>Няма задачи по тези критерии</h3>
              <p>Променете филтрите или създайте нова задача.</p>
            </div>
          ) : (
            <div className="task-list">
              {visibleTasks.map((task) => (
                <TaskCard key={task.id} task={task} viewerId={session?.user.id || null} onOpen={() => setSelectedTaskId(task.id)} />
              ))}
            </div>
          )}
        </section>
      </main>

      {calendarChoiceDate && canCreateTeamTasks && (
        <CalendarTaskChoice
          date={calendarChoiceDate}
          onPersonal={() => openCreate('personal', calendarChoiceDate)}
          onTeam={() => openCreate('team', calendarChoiceDate)}
          onClose={() => {
            setCalendarChoiceDate(null)
            setCreateDueDate(null)
          }}
        />
      )}

      {createMode && profile && (createMode === 'personal' || canCreateTeamTasks) && (
        <CreateTaskModal
          mode={createMode}
          initialDueDate={createDueDate}
          profile={profile}
          people={profiles.filter((person) => person.is_active)}
          onClose={() => {
            setCreateMode(null)
            setCreateDueDate(null)
          }}
          onCreated={async (taskId) => {
            setCreateMode(null)
            setCreateDueDate(null)
            await loadCore()
            setSelectedTaskId(taskId)
            showToast({ tone: 'success', message: 'Задачата е създадена.' })
          }}
          onRecurringCreated={async (taskId, calendarYearAhead) => {
            setCreateMode(null)
            setCreateDueDate(null)
            await loadCore()
            setSelectedTaskId(taskId)
            showToast({
              tone: 'success',
              message: calendarYearAhead
                ? 'Повтарящата се задача е създадена и повторенията ѝ се виждат в календара за 1 година напред.'
                : 'Повтарящата се задача е създадена. Следващите задачи ще се създават автоматично по зададения график.',
            })
          }}
          onError={(message) => showToast({ tone: 'error', message })}
        />
      )}

      {selectedTaskId && (
        <TaskDetail
          key={selectedTaskId}
          task={tasks.find((item) => item.id === selectedTaskId)}
          currentUser={profile}
          profiles={profiles}
          onClose={() => setSelectedTaskId(null)}
          onChanged={loadCore}
          onResult={showToast}
        />
      )}

      {passwordOpen && (
        <PasswordModal
          onClose={() => setPasswordOpen(false)}
          onResult={showToast}
        />
      )}

      {adminPasswordOpen && profile && canAdminSetTemporaryPassword && (
        <AdminTemporaryPasswordModal
          currentUserId={profile.id}
          profiles={profiles}
          onClose={() => setAdminPasswordOpen(false)}
          onResult={showToast}
        />
      )}

      {checklistsOpen && profile && (
        <ChecklistDrawer
          currentUser={profile}
          profiles={profiles}
          onClose={() => setChecklistsOpen(false)}
          onResult={showToast}
        />
      )}

      {notebookOpen && profile && (
        <NotebookDrawer
          currentUser={profile}
          initialDate={notebookTarget?.date}
          initialPageId={notebookTarget?.pageId}
          onClose={() => {
            setNotebookOpen(false)
            setNotebookTarget(null)
          }}
          onResult={showToast}
        />
      )}

      {toast && <div className={`toast ${toast.tone}`} role="status">{toast.message}</div>}
      </div>
    </>
  )
}

function AmbientBackground({ className = '' }: { className?: string }) {
  return (
    <div className={`manager-viewport-background ${className}`.trim()} aria-hidden="true">
      <img
        className="manager-silk-base-image"
        src="/manager-silk-live.avif"
        alt=""
        draggable={false}
      />

      <svg
        className="manager-live-wave-svg"
        viewBox="0 0 1600 1000"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        <defs>
          <linearGradient id="managerWaveA" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity=".88" />
            <stop offset="28%" stopColor="#dbeafe" stopOpacity=".78" />
            <stop offset="63%" stopColor="#93c5fd" stopOpacity=".43" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity=".20" />
          </linearGradient>

          <linearGradient id="managerWaveB" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#dbeafe" stopOpacity=".24" />
            <stop offset="35%" stopColor="#ffffff" stopOpacity=".72" />
            <stop offset="68%" stopColor="#c7d2fe" stopOpacity=".48" />
            <stop offset="100%" stopColor="#60a5fa" stopOpacity=".22" />
          </linearGradient>

          <linearGradient id="managerWaveC" x1="0" y1=".2" x2="1" y2=".8">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity=".08" />
            <stop offset="38%" stopColor="#bfdbfe" stopOpacity=".34" />
            <stop offset="66%" stopColor="#ffffff" stopOpacity=".58" />
            <stop offset="100%" stopColor="#818cf8" stopOpacity=".18" />
          </linearGradient>

          <linearGradient id="managerFoldShadow" x1="0" y1="0" x2="1" y2=".4">
            <stop offset="0%" stopColor="#244b86" stopOpacity=".05" />
            <stop offset="48%" stopColor="#315b95" stopOpacity=".26" />
            <stop offset="70%" stopColor="#1e3a8a" stopOpacity=".16" />
            <stop offset="100%" stopColor="#0f2f68" stopOpacity=".02" />
          </linearGradient>

          <linearGradient id="managerFineLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="18%" stopColor="#ffffff" stopOpacity=".42" />
            <stop offset="54%" stopColor="#dbeafe" stopOpacity=".78" />
            <stop offset="82%" stopColor="#ffffff" stopOpacity=".34" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>

          <radialGradient id="managerGlowA" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity=".70" />
            <stop offset="46%" stopColor="#bfdbfe" stopOpacity=".30" />
            <stop offset="100%" stopColor="#bfdbfe" stopOpacity="0" />
          </radialGradient>

        </defs>

        <g className="manager-wave manager-wave-depth">
          <path
            d="M-240 380 C80 210 355 495 675 330 C990 166 1280 292 1810 86 L1810 735 C1432 810 1130 660 800 785 C410 932 105 742 -240 922 Z"
            fill="url(#managerFoldShadow)"
          />
        </g>

        <g className="manager-wave manager-wave-a">
          <path
            d="M-180 160 C160 12 428 310 765 168 C1100 26 1320 194 1780 22 L1780 425 C1392 534 1118 382 786 500 C426 628 122 414 -180 586 Z"
            fill="url(#managerWaveA)"
          />
          <path
            d="M-130 245 C205 92 448 382 762 247 C1086 106 1325 244 1735 102"
            fill="none"
            stroke="url(#managerFineLine)"
            strokeWidth="10"
            strokeLinecap="round"
            opacity=".66"
          />
          <path
            d="M-92 315 C235 177 446 438 774 316 C1097 196 1334 335 1696 214"
            fill="none"
            stroke="rgba(80,126,183,.25)"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </g>

        <g className="manager-wave manager-wave-b">
          <path
            d="M-225 522 C128 322 395 684 748 501 C1090 325 1334 620 1805 403 L1805 818 C1427 927 1120 716 764 865 C392 1021 110 755 -225 940 Z"
            fill="url(#managerWaveB)"
          />
          <path
            d="M-112 603 C172 462 447 748 766 594 C1087 439 1325 711 1718 526"
            fill="none"
            stroke="url(#managerFineLine)"
            strokeWidth="12"
            strokeLinecap="round"
            opacity=".58"
          />
          <path
            d="M-70 674 C204 551 452 796 779 671 C1110 544 1344 779 1682 628"
            fill="none"
            stroke="rgba(56,93,151,.22)"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </g>

        <g className="manager-wave manager-wave-ribbon">
          <path
            d="M-120 438 C202 258 430 565 745 405 C1050 252 1294 470 1725 300 L1725 493 C1338 618 1110 438 776 584 C450 726 174 491 -120 665 Z"
            fill="url(#managerWaveC)"
          />
        </g>

        <g className="manager-wave manager-wave-c">
          <ellipse cx="320" cy="178" rx="330" ry="185" fill="url(#managerGlowA)" />
          <ellipse cx="1265" cy="725" rx="430" ry="250" fill="url(#managerGlowA)" />
        </g>

        <g className="manager-wave manager-wave-fibers">
          <path d="M-60 360 C260 220 466 480 790 354 C1112 228 1320 355 1660 246" />
          <path d="M-25 387 C286 258 478 506 804 383 C1126 261 1338 387 1625 294" />
          <path d="M22 722 C298 612 493 830 805 710 C1118 590 1325 785 1594 684" />
          <path d="M55 750 C328 653 520 855 831 739 C1143 622 1349 811 1566 728" />
        </g>

        <g className="manager-wave manager-wave-sheen">
          <path
            d="M-105 694 C295 516 520 749 828 633 C1153 510 1374 568 1705 414"
            fill="none"
            stroke="rgba(255,255,255,.62)"
            strokeWidth="30"
            strokeLinecap="round"
          />
          <path
            d="M-35 203 C318 76 516 319 834 198 C1130 84 1348 182 1650 94"
            fill="none"
            stroke="rgba(255,255,255,.40)"
            strokeWidth="17"
            strokeLinecap="round"
          />
        </g>
      </svg>

      <span className="manager-dynamic-vignette" />
      <span className="manager-background-grain" />
    </div>
  )
}

function OfficeLoginIntro({
  imageSrc,
  onDone,
}: {
  imageSrc: string
  onDone: () => void
}) {
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const timeout = window.setTimeout(() => onDoneRef.current(), reducedMotion ? 300 : 6200)
    return () => window.clearTimeout(timeout)
  }, [])

  return (
    <div className="office-login-intro" aria-hidden="true">
      <div className="office-intro-stage">
        <div className="office-intro-camera-rig">
          <div className="office-intro-plane">
            <img className="office-intro-photo" src={imageSrc} alt="" draggable={false} />

            <div className="office-intro-depth office-intro-depth-top">
              <img src={imageSrc} alt="" draggable={false} />
            </div>
            <div className="office-intro-depth office-intro-depth-pavement">
              <img src={imageSrc} alt="" draggable={false} />
            </div>

            <div className="office-intro-portal">
              <div className="office-intro-system-preview">
                <div className="office-intro-preview-topbar">
                  <span className="office-intro-preview-mark">✓</span>
                  <div className="office-intro-preview-copy">
                    <small>ЯВЛЕНА · ИЗТОК</small>
                    <strong>Manager Task Management</strong>
                  </div>
                </div>
                <div className="office-intro-preview-hero">
                  <small>ОБЩ ПРЕГЛЕД</small>
                  <strong>Задачи на екипа</strong>
                </div>
                <div className="office-intro-preview-grid">
                  <i /><i /><i /><i /><i /><i />
                </div>
              </div>
            </div>

            <div className="office-intro-door office-intro-door-left">
              <img src={imageSrc} alt="" draggable={false} />
              <span className="office-intro-glass-glint" />
            </div>
            <div className="office-intro-door office-intro-door-right">
              <img src={imageSrc} alt="" draggable={false} />
              <span className="office-intro-glass-glint" />
            </div>

            <span className="office-intro-threshold-light" />
          </div>
        </div>

        <span className="office-intro-motion-blur" />
        <span className="office-intro-vignette" />
        <div className="office-intro-caption">
          <span />
          <strong>Добре дошли</strong>
        </div>
      </div>
    </div>
  )
}

function Login({
  lowSpec,
  onToggleLowSpec,
}: {
  lowSpec: boolean
  onToggleLowSpec: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [resetSent, setResetSent] = useState(false)

  useEffect(() => {
    if (lowSpec) return
    const image = new Image()
    image.src = officeIntroImage
    void image.decode?.().catch(() => undefined)
  }, [lowSpec])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')

    try {
      if (lowSpec) window.sessionStorage.removeItem(OFFICE_INTRO_PENDING_KEY)
      else window.sessionStorage.setItem(OFFICE_INTRO_PENDING_KEY, '1')
    } catch {
      // Login must remain functional even when session storage is unavailable.
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      try {
        window.sessionStorage.removeItem(OFFICE_INTRO_PENDING_KEY)
      } catch {
        // Ignore storage failures while reporting the auth error.
      }
      setMessage('Невалиден имейл или парола.')
    }
    setBusy(false)
  }

  const resetPassword = async () => {
    if (!email.trim()) {
      setMessage('Въведете служебния си имейл и опитайте отново.')
      return
    }
    setBusy(true)
    setMessage('')
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${MANAGER_PRODUCTION_ORIGIN}/?${PASSWORD_RECOVERY_PARAM}=1`,
    })
    if (error) {
      const emailLimitReached = error.code === 'over_email_send_rate_limit'
        || error.message.toLowerCase().includes('email rate limit')
      setMessage(emailLimitReached
        ? 'Временният лимит за имейли е достигнат. Опитайте отново след около час или се свържете с администратора.'
        : 'Линкът за нова парола не беше изпратен. Опитайте отново по-късно.')
    }
    else setResetSent(true)
    setBusy(false)
  }

  return (
    <main className="login-page manager-login">
      <button
        type="button"
        className={`login-low-spec-toggle${lowSpec ? ' active' : ''}`}
        onClick={onToggleLowSpec}
        aria-pressed={lowSpec}
        title={lowSpec ? 'Изключи Low Spec режима' : 'Включи Low Spec режима'}
      >
        <span aria-hidden="true">⚡</span>
        {lowSpec ? 'Low Spec: Включен' : 'Low Spec режим'}
      </button>
      {!lowSpec && (
        <div className="manager-login-background" aria-hidden="true">
          <span className="manager-login-glow manager-login-glow-a" />
          <span className="manager-login-glow manager-login-glow-b" />
          <span className="manager-login-lines" />
        </div>
      )}
      {!lowSpec && <aside className="login-accent manager-login-hero" aria-hidden="true">
        <div className="executive-showcase">
          <div className="executive-kicker"><span /> MANAGER CONTROL</div>
          <div className="executive-title">
            <small>ЯВЛЕНА · ИЗТОК</small>
            <h2>Управление без<br /><em>излишен шум.</em></h2>
            <p>Център за задачи, отговорности, срокове и решения на управленския екип.</p>
          </div>

          <div className="executive-control-loop">
            <div className="control-loop-head">
              <span>CONTROL LOOP</span>
              <b><i /> СИСТЕМАТА Е АКТИВНА</b>
            </div>
            <div className="control-loop-track">
              <span className="control-loop-line" />
              <div className="control-loop-step">
                <i>01</i>
                <strong>Планирай</strong>
                <small>Ясна задача и отговорник</small>
              </div>
              <div className="control-loop-step">
                <i>02</i>
                <strong>Проследи</strong>
                <small>Срок, напредък и контрол</small>
              </div>
              <div className="control-loop-step">
                <i>03</i>
                <strong>Завърши</strong>
                <small>Решение и отчетност</small>
              </div>
            </div>
          </div>

          <div className="executive-meta">
            <span>Роли и права</span>
            <span>Мобилни известия</span>
            <span>История на действията</span>
          </div>
        </div>
      </aside>}

      <section className="login-card manager-login-card">
        <span className="manager-login-badge">ВЪТРЕШНА УПРАВЛЕНСКА СИСТЕМА</span>
        <div className="brand login-brand">
          <span className="brand-mark">✓</span>
          <div><strong>Manager Task Management</strong><small>Явлена · Изток</small></div>
        </div>
        <p className="eyebrow">Служебен достъп</p>
        <h1>Вход в управлението</h1>
        <p className="login-intro">Влезте с личния си служебен акаунт.</p>
        <form onSubmit={submit} className="stack-form">
          <label>Имейл<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Парола<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {message && <p className="form-error">{message}</p>}
          {resetSent && <p className="form-success">Изпратихме линк за нова парола. Проверете входящата си поща.</p>}
          <button className="primary-button full" disabled={busy}>{busy ? 'Влизане…' : 'Вход'}</button>
          <button type="button" className="forgot-button" onClick={() => void resetPassword()} disabled={busy}>Забравена парола?</button>
        </form>
        <small className="security-note">Достъп само за оторизирани служебни профили.</small>
      </section>
    </main>
  )
}

function PasswordModal({ onClose, onResult }: { onClose: () => void; onResult: (toast: Toast) => void }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('Паролата трябва да е поне 8 знака.')
      return
    }
    if (password !== confirmPassword) {
      setError('Двете пароли не съвпадат.')
      return
    }
    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({
      password,
      data: { password_initialized: true },
    })
    setBusy(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete(PASSWORD_RECOVERY_PARAM)
      url.hash = ''
      window.history.replaceState({}, '', `${url.pathname}${url.search}`)
    } catch {
      // Password change succeeded even if URL cleanup is unavailable.
    }
    onClose()
    onResult({ tone: 'success', message: 'Паролата е променена успешно.' })
  }

  return (
    <Modal title="Смяна на парола" onClose={onClose}>
      <form className="stack-form modal-form" onSubmit={submit}>
        <p className="modal-note">Изберете лична парола, която не използвате в друга система.</p>
        <label>Нова парола<input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>Повторете паролата<input type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Отказ</button><button className="primary-button" disabled={busy}>{busy ? 'Запазване…' : 'Запази новата парола'}</button></div>
      </form>
    </Modal>
  )
}

function AdminTemporaryPasswordModal({
  currentUserId,
  profiles,
  onClose,
  onResult,
}: {
  currentUserId: string
  profiles: Profile[]
  onClose: () => void
  onResult: (toast: Toast) => void
}) {
  const eligibleProfiles = useMemo(
    () => profiles.filter((person) => person.is_active && person.id !== currentUserId),
    [currentUserId, profiles],
  )
  const [targetUserId, setTargetUserId] = useState(eligibleProfiles[0]?.id || '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')

    if (!targetUserId) {
      setError('Изберете потребител.')
      return
    }
    if (password.length < 10) {
      setError('Временната парола трябва да е поне 10 знака.')
      return
    }
    if (password !== confirmPassword) {
      setError('Двете пароли не съвпадат.')
      return
    }

    setBusy(true)
    const { error: invokeError } = await supabase.functions.invoke('admin-set-temporary-password', {
      body: { targetUserId, password },
    })
    setBusy(false)

    if (invokeError) {
      setError(invokeError.message || 'Временната парола не можа да бъде зададена.')
      return
    }

    const target = eligibleProfiles.find((person) => person.id === targetUserId)
    onClose()
    onResult({
      tone: 'success',
      message: `Временната парола за ${target?.display_name || 'потребителя'} е зададена. При следващ вход системата ще изиска нова лична парола.`,
    })
  }

  return (
    <Modal title="Временна парола за потребител" onClose={onClose}>
      <form className="stack-form modal-form" onSubmit={submit}>
        <p className="modal-note">
          Само Управител и Модератор могат да използват тази функция. Паролата се задава директно, без recovery email.
          При следващ вход потребителят трябва да я смени.
        </p>
        <label>
          Потребител
          <select required value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)}>
            {eligibleProfiles.map((person) => (
              <option key={person.id} value={person.id}>
                {person.display_name} · {person.display_role || (person.role === 'manager' ? 'Мениджър' : 'Модератор')}
              </option>
            ))}
          </select>
        </label>
        <label>
          Временна парола
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          Повторете временната парола
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Отказ</button>
          <button className="primary-button" disabled={busy || !targetUserId}>
            {busy ? 'Задаване…' : 'Задай временна парола'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function StatCard({
  label,
  value,
  tone,
  icon,
  active,
  onClick,
}: {
  label: string
  value: number
  tone: string
  icon: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`stat-card ${tone}${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
      title={active ? `Покажи всички задачи` : `Покажи: ${label}`}
    >
      <div><span className="stat-icon">{icon}</span><p>{label}</p></div>
      <strong>{value}</strong>
    </button>
  )
}

function CalendarTaskChoice({
  date,
  onPersonal,
  onTeam,
  onClose,
}: {
  date: Date
  onPersonal: () => void
  onTeam: () => void
  onClose: () => void
}) {
  const dateLabel = formatBulgarianDateLong(date)

  return (
    <Modal title="Нова задача от календара" onClose={onClose}>
      <div className="calendar-choice">
        <div className="calendar-choice-date"><span>◷</span><div><small>Избран срок · българско време</small><strong>{dateLabel}, {formatBulgarianTime(date)} ч.</strong></div></div>
        <p>За кого искате да създадете задачата?</p>
        <div className="assignment-choice-grid">
          <button type="button" onClick={onPersonal}>
            <span className="choice-icon personal">◎</span>
            <strong>За мен</strong>
            <small>Лична задача, възложена на вашия акаунт</small>
            <i>Продължи ›</i>
          </button>
          <button type="button" onClick={onTeam}>
            <span className="choice-icon team">◫</span>
            <strong>За екипа</strong>
            <small>Екипна задача към един, двама или трима души</small>
            <i>Избери хора ›</i>
          </button>
        </div>
      </div>
    </Modal>
  )
}

function CalendarView({
  tasks,
  notebookEntries,
  notebookEnabled,
  notebookBusy,
  cursor,
  onCursorChange,
  onOpen,
  onOpenNotebook,
  onToggleNotebook,
  fullView,
  onToggleFullView,
  onCreate,
}: {
  tasks: TaskView[]
  notebookEntries: NotebookCalendarEntry[]
  notebookEnabled: boolean
  notebookBusy: boolean
  cursor: Date
  onCursorChange: (date: Date) => void
  onOpen: (taskId: string) => void
  onOpenNotebook: (entry: NotebookCalendarEntry) => void
  onToggleNotebook: () => void
  fullView: boolean
  onToggleFullView: () => void
  onCreate: (date: Date) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const firstDayOffset = (new Date(year, month, 1).getDay() + 6) % 7
  const gridStart = new Date(year, month, 1 - firstDayOffset)
  const todayKey = bulgarianDateKey(new Date())
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart)
    date.setDate(gridStart.getDate() + index)
    return date
  })
  const tasksByDay = new Map<string, TaskView[]>()
  const notebookByDay = new Map<string, NotebookCalendarEntry[]>()

  tasks.forEach((task) => {
    const calendarMoment = task.starts_at && task.ends_at ? task.starts_at : task.due_at
    const key = bulgarianDateKey(calendarMoment)
    tasksByDay.set(key, [...(tasksByDay.get(key) || []), task])
  })

  if (notebookEnabled) {
    notebookEntries.forEach((entry) => {
      notebookByDay.set(entry.page_date, [...(notebookByDay.get(entry.page_date) || []), entry])
    })
  }

  const moveMonth = (step: number) => onCursorChange(new Date(year, month + step, 1))
  const showToday = () => {
    const today = new Date()
    onCursorChange(new Date(today.getFullYear(), today.getMonth(), 1))
  }

  return (
    <div className="calendar-shell">
      <div className="calendar-toolbar">
        <h3>{bulgarianMonths[month]} {year}</h3>
        <div className="calendar-toolbar-controls">
          <button
            type="button"
            className={`calendar-notebook-toggle${notebookEnabled ? ' active' : ''}`}
            onClick={onToggleNotebook}
            disabled={notebookBusy}
            aria-pressed={notebookEnabled}
            title={notebookEnabled ? 'Скрий задачите от личния тефтер' : 'Покажи задачите от личния тефтер'}
          >
            <span aria-hidden="true">✎</span>
            <span>Тефтер</span>
            <b>{notebookBusy ? '…' : notebookEnabled ? 'Включен' : 'Изключен'}</b>
          </button>
          <div className="calendar-month-nav">
            <button type="button" onClick={() => moveMonth(-1)} aria-label="Предишен месец">‹ Предишен</button>
            <button type="button" onClick={showToday}>Днес</button>
            <button type="button" onClick={() => moveMonth(1)} aria-label="Следващ месец">Следващ ›</button>
          </div>
          <button
            type="button"
            className={`calendar-full-toggle${fullView ? ' active' : ''}`}
            onClick={onToggleFullView}
            aria-pressed={fullView}
            title={fullView ? 'Изключи пълния изглед' : 'Покажи календара в пълен изглед'}
          >
            <span aria-hidden="true">{fullView ? '↙' : '⛶'}</span>
            <span>{fullView ? 'Нормален изглед' : 'Пълен изглед'}</span>
          </button>
        </div>
      </div>
      <div className="calendar-source-note">
        <span><i className="calendar-source-dot task" /> Задачи</span>
        <span className={notebookEnabled ? 'active' : ''}><i className="calendar-source-dot notebook" /> Тефтер {notebookEnabled ? '· показан' : '· скрит'}</span>
      </div>
      <div
        ref={scrollRef}
        className="calendar-scroll"
        onWheel={(event) => {
          const shell = event.currentTarget.closest('.calendar-shell')
          if (!shell || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
          shell.scrollTop += event.deltaY
          event.preventDefault()
        }}
      >
        <div className="calendar-grid">
          {bulgarianWeekdays.map((weekday) => <div key={weekday} className="calendar-weekday">{weekday}</div>)}
          {days.map((date) => {
            const key = localDateKey(date)
            const dayTasks = tasksByDay.get(key) || []
            const dayNotebookEntries = notebookByDay.get(key) || []
            const dayItems = [
              ...dayTasks.map((task) => ({
                kind: 'task' as const,
                sortTime: formatBulgarianTime(task.starts_at && task.ends_at ? task.starts_at : task.due_at),
                task,
              })),
              ...dayNotebookEntries.map((entry) => ({
                kind: 'notebook' as const,
                sortTime: entry.scheduled_time ? entry.scheduled_time.slice(0, 5) : '99:99',
                entry,
              })),
            ].sort((left, right) => left.sortTime.localeCompare(right.sortTime))
            const visibleItemCount = dayItems.length
            const isOutside = date.getMonth() !== month
            const isToday = key === todayKey

            return (
              <div key={key} className={`calendar-day${isOutside ? ' outside-month' : ''}${isToday ? ' today' : ''}${dayNotebookEntries.length ? ' has-notebook-items' : ''}`}>
                <div className="calendar-date">
                  <button
                    type="button"
                    className="calendar-date-button"
                    onClick={() => onCreate(date)}
                    aria-label={`Създай задача за ${formatBulgarianDateLong(date)}`}
                    title={`${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`}
                  >
                    <span>{date.getDate()}</span>
                    {visibleItemCount > 0 && <small>{visibleItemCount}</small>}
                  </button>
                  <button
                    type="button"
                    className="calendar-add-button"
                    onClick={() => onCreate(date)}
                    aria-label={`Добави задача за ${formatBulgarianDateLong(date)}`}
                    title="Добави задача"
                  >＋</button>
                </div>
                <div className="calendar-day-tasks">
                  {dayItems.map((item) => item.kind === 'task' ? (
                    <button
                      type="button"
                      key={item.task.id}
                      className={`calendar-task calendar-normal-task ${item.task.priority}${isOverdue(item.task.due_at, item.task.status) ? ' overdue' : ''}`}
                      onClick={() => onOpen(item.task.id)}
                    >
                      <time>
                        {item.task.starts_at && item.task.ends_at
                          ? `${formatBulgarianTime(item.task.starts_at)}–${formatBulgarianTime(item.task.ends_at)}`
                          : formatBulgarianTime(item.task.due_at)}
                      </time>
                      <span>{item.task.description}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      key={`notebook-${item.entry.id}`}
                      className={`calendar-notebook-entry${item.entry.completed ? ' completed' : ''}`}
                      onClick={() => onOpenNotebook(item.entry)}
                      aria-label={`Тефтер, страница ${item.entry.page_number}: ${item.entry.body}`}
                    >
                      <span className="calendar-notebook-entry-head">
                        <b>✎ Тефтер</b>
                        <small>стр. {item.entry.page_number}</small>
                      </span>
                      <span className="calendar-notebook-entry-content">
                        {item.entry.scheduled_time && (
                          <time className="calendar-notebook-entry-time">
                            {item.entry.scheduled_time.slice(0, 5)}
                          </time>
                        )}
                        <span className="calendar-notebook-entry-text">{item.entry.body}</span>
                      </span>
                      {item.entry.completed && <span className="calendar-notebook-entry-done">✓ изпълнена</span>}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function TaskCard({
  task,
  viewerId,
  onOpen,
}: {
  task: TaskView
  viewerId: string | null
  onOpen: () => void
}) {
  const effectiveStatus = getViewerTaskStatus(task, viewerId)
  const overdue = isOverdue(task.due_at, effectiveStatus)
  const assignmentByUser = new Map(task.assignment_states.map((assignment) => [assignment.user_id, assignment]))
  const viewerAssignment = viewerId ? assignmentByUser.get(viewerId) : undefined

  return (
    <button className="task-card" onClick={onOpen}>
      <span className={`priority-bar ${task.priority}`} />
      <div className="task-main">
        <div className="task-badges">
          <span className={`status-badge ${effectiveStatus}`}>{statusLabels[effectiveStatus]}</span>
          {viewerAssignment?.work_status === 'new' && task.status !== 'completed' && (
            <span className="assignee-state-badge new">Чака вашето приемане</span>
          )}
          {viewerAssignment?.work_status === 'completed' && task.status !== 'completed' && (
            <span className="assignee-state-badge completed">Вашата част е готова</span>
          )}
          <span className={`priority-badge ${task.priority}`}>{priorityLabels[task.priority]}</span>
          {task.approval_required && <span className="approval-badge">Нужно одобрение</span>}
          {task.recurrence_id && <span className="approval-badge">↻ Повтаряща се</span>}
        </div>
        <h3>{task.description}</h3>
        <div className="task-meta">
          <span className={overdue ? 'overdue-text' : ''}>
            ◷ {task.starts_at && task.ends_at
              ? `${formatDateTime(task.starts_at)} → ${formatDateTime(task.ends_at)}`
              : formatDateTime(task.due_at)}
          </span>
          <span>Възложил: {task.creator?.display_name || '—'}</span>
        </div>
      </div>
      <div className="assignee-stack" aria-label={`Изпълнители: ${task.assignees.map((person) => person.display_name).join(', ')}`}>
        {task.assignees.map((person) => {
          const state = assignmentByUser.get(person.id)?.work_status || 'new'
          return (
            <span
              key={person.id}
              className={`assignee-avatar-state ${state}`}
              title={`${person.display_name} · ${assigneeWorkStatusLabels[state]}`}
            >
              {initials(person.display_name)}
            </span>
          )
        })}
      </div>
      <span className="chevron">›</span>
    </button>
  )
}

function BulgarianDateTimeField({
  value,
  onChange,
  legend = 'Краен срок',
  previewLabel = 'Точен срок за България',
}: {
  value: string
  onChange: (value: string) => void
  legend?: string
  previewLabel?: string
}) {
  const [datePart = '', timePart = '17:00'] = value.split('T')
  const [rawYear, rawMonth, rawDay] = datePart.split('-').map(Number)
  const [rawHour, rawMinute] = timePart.split(':').map(Number)
  const now = new Date()
  const year = rawYear || now.getFullYear()
  const month = rawMonth || now.getMonth() + 1
  const day = rawDay || now.getDate()
  const hour = Number.isFinite(rawHour) ? rawHour : 17
  const minute = Number.isFinite(rawMinute) ? rawMinute : 0
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDayOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const selectedDate = new Date(year, month - 1, day)
  const selectedWeekday = new Intl.DateTimeFormat('bg-BG', { weekday: 'long' }).format(selectedDate)
  const calendarCells = [
    ...Array.from({ length: firstDayOffset }, () => null as number | null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ]
  const firstYear = Math.min(now.getFullYear() - 1, year)
  const lastYear = Math.max(now.getFullYear() + 10, year)
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index)

  const update = (next: Partial<{ year: number; month: number; day: number; hour: number; minute: number }>) => {
    const nextYear = next.year ?? year
    const nextMonth = next.month ?? month
    const maxDay = new Date(nextYear, nextMonth, 0).getDate()
    const nextDay = Math.min(next.day ?? day, maxDay)
    const nextHour = next.hour ?? hour
    const nextMinute = next.minute ?? minute
    onChange(
      `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}T${String(nextHour).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`,
    )
  }

  return (
    <fieldset className="bulgarian-datetime">
      <legend>{legend} <small>български формат</small></legend>
      <div className="bulgarian-datetime-controls">
        <label>
          <span>Ден</span>
          <select aria-label="Ден" value={day} onChange={(event) => update({ day: Number(event.target.value) })}>
            {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((item) => <option key={item} value={item}>{String(item).padStart(2, '0')}</option>)}
          </select>
        </label>
        <label className="month-control">
          <span>Месец</span>
          <select aria-label="Месец" value={month} onChange={(event) => update({ month: Number(event.target.value) })}>
            {bulgarianMonths.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
          </select>
        </label>
        <label>
          <span>Година</span>
          <select aria-label="Година" value={year} onChange={(event) => update({ year: Number(event.target.value) })}>
            {years.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <span className="datetime-at" aria-hidden="true">в</span>
        <label>
          <span>Час</span>
          <select aria-label="Час по 24-часов формат" value={hour} onChange={(event) => update({ hour: Number(event.target.value) })}>
            {Array.from({ length: 24 }, (_, index) => index).map((item) => <option key={item} value={item}>{String(item).padStart(2, '0')}</option>)}
          </select>
        </label>
        <span className="datetime-separator" aria-hidden="true">:</span>
        <label>
          <span>Минути</span>
          <select aria-label="Минути" value={minute} onChange={(event) => update({ minute: Number(event.target.value) })}>
            {Array.from({ length: 60 }, (_, index) => index).map((item) => <option key={item} value={item}>{String(item).padStart(2, '0')}</option>)}
          </select>
        </label>
      </div>
      <div className="bulgarian-mini-calendar" aria-label="Мини календар за избраната дата">
        <div className="bulgarian-mini-calendar-title">
          <strong>{bulgarianMonths[month - 1]} {year}</strong>
          <span>{selectedWeekday}</span>
        </div>
        <div className="bulgarian-mini-calendar-grid">
          {bulgarianWeekdayShort.map((weekday) => <small key={weekday}>{weekday}</small>)}
          {calendarCells.map((calendarDay, index) => calendarDay === null
            ? <i key={`empty-${index}`} />
            : (
              <button
                key={calendarDay}
                type="button"
                className={calendarDay === day ? 'active' : ''}
                onClick={() => update({ day: calendarDay })}
                aria-label={`${calendarDay} ${bulgarianMonths[month - 1]} ${year}`}
              >
                {calendarDay}
              </button>
            ))}
        </div>
      </div>
      <div className="bulgarian-datetime-preview">
        <span>◷</span>
        <div>
          <small>{previewLabel}</small>
          <strong>{selectedWeekday} · {String(day).padStart(2, '0')}.{String(month).padStart(2, '0')}.{year} г. · {String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')} ч.</strong>
        </div>
      </div>
    </fieldset>
  )
}

function CreateTaskModal({
  mode,
  initialDueDate,
  profile,
  people,
  onClose,
  onCreated,
  onRecurringCreated,
  onError,
}: {
  mode: CreateMode
  initialDueDate: Date | null
  profile: Profile
  people: Profile[]
  onClose: () => void
  onCreated: (taskId: string) => Promise<void>
  onRecurringCreated: (taskId: string, calendarYearAhead: boolean) => Promise<void>
  onError: (message: string) => void
}) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
  tomorrow.setHours(17, 0, 0, 0)
  const initialSchedule = initialDueDate || tomorrow
  const initialWeekday = initialSchedule.getDay() === 0 ? 7 : initialSchedule.getDay()
  const [description, setDescription] = useState('')
  const [scheduleMode, setScheduleMode] = useState<TaskScheduleMode>('deadline')
  const [dueAt, setDueAt] = useState(dateTimeLocalValue(initialSchedule))
  const [startAt, setStartAt] = useState(() => {
    const start = new Date(initialSchedule)
    start.setHours(start.getHours() - 1)
    return dateTimeLocalValue(start)
  })
  const [endAt, setEndAt] = useState(dateTimeLocalValue(initialSchedule))
  const [materials, setMaterials] = useState('')
  const [approvalRequired, setApprovalRequired] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [attachments, setAttachments] = useState<File[]>([])
  const [reminderEnabled, setReminderEnabled] = useState(false)
  const [remindAt, setRemindAt] = useState(() => defaultReminderForDue(dateTimeLocalValue(initialSchedule)))
  const [recurring, setRecurring] = useState(false)
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceFrequency>('weekly')
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState<number[]>([initialWeekday])
  const [recurrenceMonthDay, setRecurrenceMonthDay] = useState(initialSchedule.getDate())
  const [recurrenceLeadDays, setRecurrenceLeadDays] = useState(1)
  const [calendarYearAhead, setCalendarYearAhead] = useState(false)
  const [busy, setBusy] = useState(false)
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceInterim, setVoiceInterim] = useState('')
  const [voiceMessage, setVoiceMessage] = useState('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const voiceBaseDescriptionRef = useRef('')
  const voiceFinalSegmentsRef = useRef<Map<number, string>>(new Map())
  const voiceLastDescriptionRef = useRef('')
  const voiceShouldListenRef = useRef(false)
  const voiceStartPendingRef = useRef(false)
  const voiceRestartTimerRef = useRef<number | null>(null)
  const personal = mode === 'personal'
  const voiceEnabled = true
  const governorTeamColumns = useMemo(() => {
    const byName = new Map(people.map((person) => [person.display_name, person]))
    const groupedNames = new Set(GOVERNOR_TEAM_ASSIGNEE_COLUMNS.flat())

    const columns = GOVERNOR_TEAM_ASSIGNEE_COLUMNS.map((names) =>
      names
        .map((name) => byName.get(name))
        .filter((person): person is Profile => Boolean(person)),
    )

    const ungrouped = people.filter((person) => !groupedNames.has(person.display_name as typeof GOVERNOR_TEAM_ASSIGNEE_COLUMNS[number][number]))
    if (ungrouped.length > 0) columns[2] = [...columns[2], ...ungrouped]

    return columns
  }, [people])

  useEffect(() => () => {
    voiceShouldListenRef.current = false
    if (voiceRestartTimerRef.current !== null) window.clearTimeout(voiceRestartTimerRef.current)
    recognitionRef.current?.abort()
    recognitionRef.current = null
  }, [])

  const stopVoiceDictation = () => {
    voiceShouldListenRef.current = false
    voiceStartPendingRef.current = false
    if (voiceRestartTimerRef.current !== null) {
      window.clearTimeout(voiceRestartTimerRef.current)
      voiceRestartTimerRef.current = null
    }
    recognitionRef.current?.stop()
    setVoiceListening(false)
    setVoiceInterim('')
  }

  const startVoiceDictation = async () => {
    if (!voiceEnabled || voiceListening || voiceStartPendingRef.current) return
    const Recognition = getSpeechRecognitionConstructor()

    if (!Recognition) {
      setVoiceMessage('Този браузър не поддържа гласово въвеждане. Използвайте актуален Chrome или Edge.')
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
    voiceBaseDescriptionRef.current = description.trim()
    voiceLastDescriptionRef.current = description.trim()
    voiceFinalSegmentsRef.current = new Map()
    setVoiceMessage('Стартиране на диктовката…')
    setVoiceInterim('')

    recognition.onstart = () => {
      if (!voiceShouldListenRef.current) return
      setVoiceListening(true)
      setVoiceMessage('')
    }

    recognition.onresult = (event) => {
      const interimChunks: string[] = []

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = result[0]?.transcript?.trim() || ''
        if (!transcript) continue

        if (result.isFinal) {
          voiceFinalSegmentsRef.current.set(index, transcript)
        } else {
          interimChunks.push(transcript)
        }
      }

      const finalChunks = Array.from(voiceFinalSegmentsRef.current.entries())
        .sort(([left], [right]) => left - right)
        .map(([, transcript]) => transcript)

      const mergedFinal = mergeSpeechChunks(finalChunks)
      const combined = [voiceBaseDescriptionRef.current, mergedFinal].filter(Boolean).join(' ')
      const formatted = applyBulgarianVoiceFormatting(combined)
      voiceLastDescriptionRef.current = formatted
      setDescription(formatted)
      setVoiceInterim(applyBulgarianVoiceFormatting(mergeSpeechChunks(interimChunks)))
    }

    recognition.onerror = (event) => {
      const message = speechRecognitionErrorMessage(event.error)
      voiceShouldListenRef.current = false
      if (voiceRestartTimerRef.current !== null) {
        window.clearTimeout(voiceRestartTimerRef.current)
        voiceRestartTimerRef.current = null
      }
      setVoiceListening(false)
      setVoiceInterim('')
      if (message) setVoiceMessage(message)
    }

    recognition.onend = () => {
      setVoiceInterim('')

      if (!voiceShouldListenRef.current) {
        setVoiceListening(false)
        recognitionRef.current = null
        voiceFinalSegmentsRef.current = new Map()
        return
      }

      voiceBaseDescriptionRef.current = voiceLastDescriptionRef.current.trim()
      voiceFinalSegmentsRef.current = new Map()
      voiceRestartTimerRef.current = window.setTimeout(() => {
        voiceRestartTimerRef.current = null
        if (!voiceShouldListenRef.current) return
        try {
          recognition.start()
        } catch {
          voiceShouldListenRef.current = false
          recognitionRef.current = null
          setVoiceListening(false)
          setVoiceMessage('Диктовката беше прекъсната и не можа да се рестартира. Натиснете „Диктувай“ отново.')
        }
      }, 300)
    }

    try {
      recognition.start()
    } catch {
      voiceShouldListenRef.current = false
      recognitionRef.current = null
      setVoiceListening(false)
      setVoiceMessage('Микрофонът е достъпен, но разпознаването на реч не можа да бъде стартирано. Опитайте отново в Chrome или Edge.')
    }
  }

  const uploadNewTaskFile = async (taskId: string, file: File) => {
    const { data: logical, error: logicalError } = await supabase
      .from('logical_files')
      .insert({
        task_id: taskId,
        progress_update_id: null,
        parent_type: 'task',
        display_name: file.name,
        created_by: profile.id,
      })
      .select('id')
      .single()
    if (logicalError || !logical) throw logicalError || new Error('Файлът не беше регистриран.')

    const storagePath = `${profile.id}/${taskId}/${logical.id}/v1-${crypto.randomUUID()}-${safeFileName(file.name)}`
    const { error: storageError } = await supabase.storage.from('task-files').upload(storagePath, file, {
      upsert: false,
      contentType: file.type || undefined,
    })
    if (storageError) throw storageError

    const { error: versionError } = await supabase.from('file_versions').insert({
      logical_file_id: logical.id,
      version_number: 1,
      storage_path: storagePath,
      original_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: profile.id,
      sha256: await hexDigest(file),
    })
    if (versionError) throw versionError
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (voiceListening) stopVoiceDictation()
    if (!personal && selected.length < 1) {
      onError('Изберете поне един изпълнител.')
      return
    }

    const effectiveDueAt = scheduleMode === 'interval' && !recurring ? endAt : dueAt
    if (scheduleMode === 'interval' && !recurring) {
      const start = new Date(startAt)
      const end = new Date(endAt)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        onError('Крайният момент трябва да бъде след началния.')
        return
      }
    }

    if (reminderEnabled && !recurring) {
      const reminderError = validateTaskReminder(remindAt, effectiveDueAt)
      if (reminderError) {
        onError(reminderError)
        return
      }
    }
    setBusy(true)

    if (recurring) {
      const [startDate, localTime = '17:00'] = dueAt.split('T')
      const { data, error } = await supabase.rpc('create_recurring_task', {
        p_description: description.trim(),
        p_priority: 'normal',
        p_required_materials: materials.trim() || null,
        p_approval_required: approvalRequired,
        p_assignee_ids: personal ? [profile.id] : selected,
        p_personal: personal,
        p_frequency: recurrenceFrequency,
        p_start_date: startDate,
        p_time_local: `${localTime}:00`,
        p_weekday: recurrenceFrequency === 'weekly' ? recurrenceWeekdays[0] ?? null : null,
        p_month_day: recurrenceFrequency === 'monthly' ? recurrenceMonthDay : null,
        p_lead_days: recurrenceLeadDays,
        p_weekdays: recurrenceFrequency === 'weekly' ? recurrenceWeekdays : null,
      })

      if (error || !data) {
        onError(error?.message || 'Повтарящата се задача не беше създадена.')
        setBusy(false)
        return
      }
      const taskId = data as string
      if (calendarYearAhead) {
        const { data: recurrenceTask, error: recurrenceLookupError } = await supabase
          .from('tasks')
          .select('recurrence_id')
          .eq('id', taskId)
          .single()

        if (recurrenceLookupError || !recurrenceTask?.recurrence_id) {
          setBusy(false)
          await onRecurringCreated(taskId, false)
          onError(`Задачата е създадена, но календарът за 1 година напред не беше активиран: ${recurrenceLookupError?.message || 'Липсва recurrence ID.'}`)
          return
        }

        const { error: calendarProjectionError } = await supabase
          .from('task_recurrences')
          .update({ calendar_year_ahead: true })
          .eq('id', recurrenceTask.recurrence_id)

        if (calendarProjectionError) {
          setBusy(false)
          await onRecurringCreated(taskId, false)
          onError(`Задачата е създадена, но календарът за 1 година напред не беше активиран: ${calendarProjectionError.message}`)
          return
        }
      }

      await onRecurringCreated(taskId, calendarYearAhead)
      return
    }

    const { data, error } = await supabase.rpc('create_task_with_assignees', {
      p_description: description.trim(),
      p_due_at: new Date(effectiveDueAt).toISOString(),
      p_priority: 'normal',
      p_required_materials: materials.trim() || null,
      p_approval_required: approvalRequired,
      p_assignee_ids: personal ? [profile.id] : selected,
      p_personal: personal,
    })

    if (error || !data) {
      onError(error?.message || 'Задачата не беше създадена.')
      setBusy(false)
      return
    }

    const taskId = data as string
    try {
      if (scheduleMode === 'interval') {
        const { error: intervalError } = await supabase
          .from('tasks')
          .update({
            starts_at: new Date(startAt).toISOString(),
            ends_at: new Date(endAt).toISOString(),
          })
          .eq('id', taskId)
          .eq('created_by', profile.id)
        if (intervalError) throw new Error(`Интервалът не беше записан: ${intervalError.message}`)
      }

      for (const file of attachments) await uploadNewTaskFile(taskId, file)
      if (reminderEnabled) {
        const { error: reminderError } = await supabase.from('task_reminders').insert({
          task_id: taskId,
          created_by: profile.id,
          remind_at: new Date(remindAt).toISOString(),
        })
        if (reminderError) throw new Error(`Напомнянето не беше записано: ${reminderError.message}`)
      }
    } catch (setupError) {
      setBusy(false)
      await onCreated(taskId)
      onError(`Задачата е създадена, но част от допълненията не бяха записани: ${errorText(setupError)}`)
      return
    }

    await onCreated(taskId)
  }

  const recurrenceLeadDescription = recurrenceLeadDays === 0
    ? 'създава се веднага при настъпване на срока'
    : `${recurrenceLeadLabel(recurrenceLeadDays)} предварително`
  const recurrenceDescription = recurrenceFrequency === 'daily'
    ? `Всеки ден · ${recurrenceLeadDescription}`
    : recurrenceFrequency === 'weekly'
      ? `Всяка седмица · ${recurrenceWeekdays.map((day) => bulgarianWeekdayShort[day - 1]).join(', ')} · ${recurrenceLeadDescription}`
      : `Всеки месец · ${recurrenceMonthDay}-во/число · ${recurrenceLeadDescription}`

  return (
    <Modal title={personal ? 'Нова лична задача' : 'Нова екипна задача'} onClose={onClose} className="task-create-modal">
      <form onSubmit={submit} className="stack-form modal-form">
        <label className={voiceEnabled ? 'voice-description-field' : undefined}>
          <span className="voice-description-heading">
            <span>Описание</span>
            {voiceEnabled && (
              <button
                type="button"
                className={`voice-dictation-button${voiceListening ? ' listening' : ''}`}
                onClick={voiceListening ? stopVoiceDictation : startVoiceDictation}
                disabled={busy}
              >
                <span className="voice-mic" aria-hidden="true">🎙</span>
                {voiceListening ? 'Спри диктовката' : 'Диктувай'}
              </button>
            )}
          </span>
          <textarea required rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={voiceEnabled ? 'Напишете задачата или натиснете „Диктувай“…' : 'Какво трябва да бъде изпълнено?'} />
          {voiceEnabled && voiceListening && (
            <span className="voice-live-status"><i /> Слушам… {voiceInterim && <em>{voiceInterim}</em>}</span>
          )}
          {voiceEnabled && voiceMessage && <span className="voice-help-message">{voiceMessage}</span>}
        </label>
        <fieldset className="task-schedule-mode">
          <legend>Кога се случва задачата</legend>
          <div className="task-schedule-mode-header">
            <div className="view-switch" aria-label="Режим на дата и час">
              <button
                type="button"
                className={scheduleMode === 'deadline' ? 'active' : ''}
                onClick={() => setScheduleMode('deadline')}
                aria-pressed={scheduleMode === 'deadline'}
              >
                Избери краен срок
              </button>
              <button
                type="button"
                className={scheduleMode === 'interval' ? 'active' : ''}
                onClick={() => setScheduleMode('interval')}
                aria-pressed={scheduleMode === 'interval'}
                disabled={recurring}
                title={recurring ? 'Повтарящите се задачи използват краен срок.' : undefined}
              >
                Избери начало и край
              </button>
            </div>
            <small>
              {scheduleMode === 'interval' && !recurring
                ? 'Подходящо за срещи, огледи и събития с реална продължителност.'
                : 'Задачата има краен срок, без фиксиран времеви интервал.'}
            </small>
          </div>

          {scheduleMode === 'interval' && !recurring ? (
            <div className="task-schedule-range-grid">
              <BulgarianDateTimeField value={startAt} onChange={setStartAt} legend="Начало" previewLabel="Начало на събитието" />
              <BulgarianDateTimeField value={endAt} onChange={setEndAt} legend="Край" previewLabel="Край на събитието" />
            </div>
          ) : (
            <BulgarianDateTimeField
              value={dueAt}
              onChange={setDueAt}
              legend={recurring ? 'Първи срок' : 'Краен срок'}
              previewLabel={recurring ? 'Първата задача се създава веднага с този срок' : 'Точен краен срок за България'}
            />
          )}
        </fieldset>

        <fieldset style={{ padding: 14, border: '1px solid #dbe7f6', borderRadius: 14, background: '#f8faff' }}>
          <legend style={{ padding: '0 6px', fontWeight: 750 }}>Повторение на задачата</legend>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="view-switch" aria-label="Повторение на задачата">
              <button type="button" className={!recurring ? 'active' : ''} onClick={() => setRecurring(false)} aria-pressed={!recurring}>Не</button>
              <button type="button" className={recurring ? 'active' : ''} onClick={() => { setRecurring(true); setScheduleMode('deadline') }} aria-pressed={recurring}>Да</button>
            </div>
            <span style={{ color: '#71809b', fontSize: 12 }}>{recurring ? recurrenceDescription : 'Задачата ще бъде еднократна.'}</span>
          </div>

          {recurring && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginTop: 14 }}>
              <label>Честота
                <select value={recurrenceFrequency} onChange={(event) => setRecurrenceFrequency(event.target.value as RecurrenceFrequency)}>
                  <option value="daily">Всеки ден</option>
                  <option value="weekly">Всяка седмица</option>
                  <option value="monthly">Всеки месец</option>
                </select>
              </label>
              {recurrenceFrequency === 'weekly' && (
                <fieldset className="recurrence-weekday-picker">
                  <legend>Дни от седмицата</legend>
                  <div>
                    {bulgarianWeekdays.map((weekday, index) => {
                      const value = index + 1
                      const active = recurrenceWeekdays.includes(value)
                      return (
                        <button
                          key={weekday}
                          type="button"
                          className={active ? 'active' : ''}
                          aria-pressed={active}
                          onClick={() => setRecurrenceWeekdays((current) => {
                            if (current.includes(value)) {
                              return current.length === 1 ? current : current.filter((day) => day !== value)
                            }
                            return [...current, value].sort((left, right) => left - right)
                          })}
                        >
                          <span>{bulgarianWeekdayShort[index]}</span>
                          <small>{weekday}</small>
                        </button>
                      )
                    })}
                  </div>
                </fieldset>
              )}
              {recurrenceFrequency === 'monthly' && (
                <label>Ден от месеца
                  <select value={recurrenceMonthDay} onChange={(event) => setRecurrenceMonthDay(Number(event.target.value))}>
                    {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}
                  </select>
                </label>
              )}
              <label>Кога да се създава задачата
                <select value={recurrenceLeadDays} onChange={(event) => setRecurrenceLeadDays(Number(event.target.value))}>
                  {[0, 1, 2, 3, 4].map((days) => (
                    <option key={days} value={days}>
                      {days === 0 ? 'Веднага (0 дни предварително)' : `${recurrenceLeadLabel(days)} преди крайния срок`}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ alignSelf: 'end', minHeight: 42, display: 'flex', alignItems: 'center', padding: '0 12px', color: '#4e6590', background: '#eef4ff', border: '1px solid #d6e3f6', borderRadius: 10, fontSize: 12 }}>
                Първата задача се създава веднага. Всеки следващ екземпляр {recurrenceLeadDays === 0 ? 'ще се създава веднага при настъпване на собствения си срок.' : <>ще се появява {recurrenceLeadLabel(recurrenceLeadDays)} преди собствения си краен срок.</>}
              </div>
              <label className="switch-row" style={{ gridColumn: '1 / -1', marginTop: 2 }}>
                <input
                  type="checkbox"
                  checked={calendarYearAhead}
                  onChange={(event) => setCalendarYearAhead(event.target.checked)}
                />
                <span>📅 Покажи повторенията в календара за 1 година напред</span>
              </label>
            </div>
          )}
        </fieldset>

        {!recurring ? (
          <fieldset style={{ padding: 14, border: '1px solid #dbe7f6', borderRadius: 14, background: '#fbfcff' }}>
            <legend style={{ padding: '0 6px', fontWeight: 750 }}>🔔 Напомняне за задачата</legend>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div className="view-switch" aria-label="Напомняне за задачата">
                <button type="button" className={!reminderEnabled ? 'active' : ''} onClick={() => setReminderEnabled(false)} aria-pressed={!reminderEnabled}>Не</button>
                <button type="button" className={reminderEnabled ? 'active' : ''} onClick={() => setReminderEnabled(true)} aria-pressed={reminderEnabled}>Да</button>
              </div>
              <span style={{ color: '#71809b', fontSize: 12 }}>Известието се изпраща до изпълнителите, които са включили „Известия“.</span>
            </div>
            {reminderEnabled && (
              <div style={{ marginTop: 14 }}>
                <BulgarianDateTimeField value={remindAt} onChange={setRemindAt} legend="Изпрати напомнянето" previewLabel="Момент на push известието" />
              </div>
            )}
          </fieldset>
        ) : (
          <div style={{ padding: '11px 13px', border: '1px solid #e1e7f2', borderRadius: 10, background: '#fafbff', color: '#71809a', fontSize: 12 }}>
            🔔 След създаването ще се отвори първата задача и при нужда можеш да ѝ зададеш отделно напомняне.
          </div>
        )}

        <label>Необходими материали<textarea rows={2} value={materials} onChange={(event) => setMaterials(event.target.value)} placeholder="Линкове, документи или допълнителна информация" /></label>
        {!recurring ? (
          <div>
            <label className="upload-drop">📎 Прикачи файлове към задачата
              <input
                type="file"
                multiple
                disabled={busy}
                onChange={(event) => setAttachments(Array.from(event.target.files || []))}
              />
            </label>
            {attachments.length > 0 && (
              <small className="selected-files" style={{ display: 'block', marginTop: 7 }}>
                Избрани файлове ({attachments.length}): {attachments.map((file) => file.name).join(', ')}
              </small>
            )}
            <small className="muted" style={{ display: 'block', marginTop: 5 }}>До 50 MB на файл. Файловете ще се качат заедно със задачата.</small>
          </div>
        ) : (
          <div style={{ padding: '11px 13px', border: '1px solid #e1e7f2', borderRadius: 10, background: '#fafbff', color: '#71809a', fontSize: 12 }}>
            📎 След създаването ще се отвори първата задача и можеш веднага да добавиш файлове към нея.
          </div>
        )}
        <fieldset>
          <legend>{personal ? 'Изпълнител' : <>Изпълнители <small>(изберете поне 1)</small></>}</legend>
          <div className={personal ? 'people-picker' : 'team-people-columns'}>
            {personal ? (
              <div className="personal-assignee">
                <span className="avatar small">{initials(profile.display_name)}</span>
                <div><strong>{profile.display_name}</strong><small>Задачата ще бъде възложена на вас</small></div>
              </div>
            ) : governorTeamColumns.map((column, columnIndex) => (
              <div className="team-people-column" key={columnIndex}>
                {column.map((person) => (
                  <label key={person.id} className={selected.includes(person.id) ? 'selected' : ''}>
                    <input
                      type="checkbox"
                      checked={selected.includes(person.id)}
                      onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))}
                    />
                    <span className="avatar small">{initials(person.display_name)}</span>
                    <span>{person.display_name}</span>
                  </label>
                ))}
              </div>
            ))}
            {!personal && people.length === 0 && <p className="muted">Няма други активни служебни профили.</p>}
          </div>
        </fieldset>
        <label className="switch-row"><input type="checkbox" checked={approvalRequired} onChange={(event) => setApprovalRequired(event.target.checked)} /><span>Необходимо е одобрение преди завършване</span></label>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Отказ</button><button className="primary-button" disabled={busy}>{busy ? (attachments.length > 0 && !recurring ? 'Създаване и качване…' : 'Създаване…') : recurring ? 'Създай повтаряща се задача' : 'Създай задача'}</button></div>
      </form>
    </Modal>
  )
}

function TaskDetail({
  task,
  currentUser,
  profiles,
  onClose,
  onChanged,
  onResult,
}: {
  task?: TaskView
  currentUser: Profile | null
  profiles: Profile[]
  onClose: () => void
  onChanged: () => Promise<void>
  onResult: (toast: Toast) => void
}) {
  const [tab, setTab] = useState<DetailTab>('progress')
  const [updates, setUpdates] = useState<ProgressUpdate[]>([])
  const [files, setFiles] = useState<LogicalFile[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [recurrenceActive, setRecurrenceActive] = useState(false)
  const [recurrenceLeadDays, setRecurrenceLeadDays] = useState(1)
  const [loading, setLoading] = useState(true)
  const [updateBody, setUpdateBody] = useState('')
  const [updateFiles, setUpdateFiles] = useState<File[]>([])
  const [approvalNote, setApprovalNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [statusChoice, setStatusChoice] = useState<TaskStatus>('new')
  const [editing, setEditing] = useState(false)
  const [editDescription, setEditDescription] = useState('')
  const [editScheduleMode, setEditScheduleMode] = useState<TaskScheduleMode>('deadline')
  const [editDueAt, setEditDueAt] = useState('')
  const [editStartAt, setEditStartAt] = useState('')
  const [editEndAt, setEditEndAt] = useState('')
  const [editMaterials, setEditMaterials] = useState('')
  const [editApprovalRequired, setEditApprovalRequired] = useState(false)
  const [editFiles, setEditFiles] = useState<File[]>([])
  const [reminder, setReminder] = useState<TaskReminder | null>(null)
  const [editReminderEnabled, setEditReminderEnabled] = useState(false)
  const [editRemindAt, setEditRemindAt] = useState('')

  const byId = useMemo(() => new Map(profiles.map((person) => [person.id, person])), [profiles])
  const assignmentByUser = useMemo(
    () => new Map((task?.assignment_states || []).map((assignment) => [assignment.user_id, assignment])),
    [task],
  )
  const isCreator = Boolean(task && currentUser && task.created_by === currentUser.id)
  const currentAssignment = currentUser ? assignmentByUser.get(currentUser.id) : undefined
  const isAssignee = Boolean(currentAssignment)
  const canParticipate = Boolean(task && currentUser && (currentUser.role === 'manager' || isAssignee))
  const canAccept = Boolean(task && task.status !== 'completed' && currentAssignment?.work_status === 'new')
  const canWork = Boolean(task && task.status !== 'completed' && currentAssignment?.work_status === 'in_progress')
  const canManageFiles = Boolean(task && (canWork || isCreator))
  const assigneeCount = task?.assignment_states.length || 0
  const completedAssigneeCount = task?.assignment_states.filter((assignment) => assignment.work_status === 'completed').length || 0

  useEffect(() => {
    if (!task) return
    setStatusChoice(task.status)
    setEditDescription(task.description)
    const dueLocal = `${bulgarianDateKey(task.due_at)}T${formatBulgarianTime(task.due_at)}`
    setEditDueAt(dueLocal)
    setEditScheduleMode(task.starts_at && task.ends_at ? 'interval' : 'deadline')
    if (task.starts_at && task.ends_at) {
      setEditStartAt(`${bulgarianDateKey(task.starts_at)}T${formatBulgarianTime(task.starts_at)}`)
      setEditEndAt(`${bulgarianDateKey(task.ends_at)}T${formatBulgarianTime(task.ends_at)}`)
    } else {
      const fallbackEnd = new Date(task.due_at)
      const fallbackStart = new Date(fallbackEnd)
      fallbackStart.setHours(fallbackStart.getHours() - 1)
      setEditStartAt(dateTimeLocalValue(fallbackStart))
      setEditEndAt(dueLocal)
    }
    setEditMaterials(task.required_materials || '')
    setEditApprovalRequired(task.approval_required)
    setEditFiles([])
    setReminder(null)
    setEditReminderEnabled(false)
    setEditRemindAt(defaultReminderForDue(`${bulgarianDateKey(task.due_at)}T${formatBulgarianTime(task.due_at)}`))
    setEditing(false)
  }, [task])

  useEffect(() => {
    if (!task || editing) return
    if (reminder && !reminder.sent_at) {
      setEditReminderEnabled(true)
      setEditRemindAt(`${bulgarianDateKey(reminder.remind_at)}T${formatBulgarianTime(reminder.remind_at)}`)
    } else {
      setEditReminderEnabled(false)
      setEditRemindAt(defaultReminderForDue(`${bulgarianDateKey(task.due_at)}T${formatBulgarianTime(task.due_at)}`))
    }
  }, [reminder, editing, task])

  const loadDetail = useCallback(async () => {
    if (!task) return
    const [updatesResult, filesResult, approvalsResult, activityResult, reminderResult] = await Promise.all([
      supabase.from('progress_updates').select('*').eq('task_id', task.id).order('created_at', { ascending: false }),
      supabase.from('logical_files').select('*, file_versions(*)').eq('task_id', task.id).order('created_at', { ascending: false }),
      supabase.from('approvals').select('*').eq('task_id', task.id).order('requested_at', { ascending: false }),
      supabase.from('activity_log').select('*').eq('task_id', task.id).order('created_at', { ascending: false }).limit(100),
      supabase.from('task_reminders').select('*').eq('task_id', task.id).maybeSingle(),
    ])
    const recurrenceResult = task.recurrence_id
      ? await supabase.from('task_recurrences').select('is_active, lead_days').eq('id', task.recurrence_id).maybeSingle()
      : { data: null, error: null }
    const firstError = updatesResult.error || filesResult.error || approvalsResult.error || activityResult.error || reminderResult.error || recurrenceResult.error
    if (firstError) onResult({ tone: 'error', message: firstError.message })
    setUpdates((updatesResult.data || []) as ProgressUpdate[])
    setFiles((filesResult.data || []) as LogicalFile[])
    setApprovals((approvalsResult.data || []) as Approval[])
    setActivity((activityResult.data || []) as ActivityEntry[])
    setReminder((reminderResult.data as TaskReminder | null) || null)
    setRecurrenceActive(Boolean(recurrenceResult.data?.is_active))
    if (recurrenceResult.data?.lead_days !== null && recurrenceResult.data?.lead_days !== undefined) setRecurrenceLeadDays(Number(recurrenceResult.data.lead_days))
    setLoading(false)
  }, [task, onResult])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  useEffect(() => {
    if (!task) return
    const reload = () => void loadDetail()
    const channel = supabase
      .channel(`detail-${task.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'progress_updates', filter: `task_id=eq.${task.id}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignees', filter: `task_id=eq.${task.id}` }, () => { void onChanged(); reload() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals', filter: `task_id=eq.${task.id}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `task_id=eq.${task.id}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_recurrences', filter: task.recurrence_id ? `id=eq.${task.recurrence_id}` : undefined }, reload)
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [task, loadDetail])

  if (!task || !currentUser) {
    return <Modal title="Задача" onClose={onClose}><InlineLoader /></Modal>
  }

  const acceptTask = async () => {
    if (!canAccept || busy) return
    setBusy(true)

    try {
      const { error } = await supabase.rpc('accept_task_assignment', { p_task_id: task.id })
      if (error) throw error

      await Promise.all([onChanged(), loadDetail()])
      onResult({
        tone: 'success',
        message: assigneeCount > 1
          ? 'Вие приехте задачата. Вашият статус вече е „В процес“, без да се променя статусът на останалите изпълнители.'
          : 'Задачата е приета и вече е „В процес“.',
      })
    } catch (error) {
      onResult({ tone: 'error', message: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (status: TaskStatus) => {
    if (status === 'new' || status === 'completed' || busy) return

    if (statusChoice === 'waiting_approval' && hasPendingApproval && status !== 'waiting_approval') {
      onResult({ tone: 'error', message: 'Задачата вече е изпратена за одобрение и чака решение от Управителя.' })
      return
    }

    const previousStatus = statusChoice
    setStatusChoice(status)
    setBusy(true)

    try {
      const updatePayload = status === 'waiting_approval'
        ? { status, approval_required: true }
        : { status }

      const { data: updated, error } = await supabase
        .from('tasks')
        .update(updatePayload)
        .eq('id', task.id)
        .select('id,status,approval_required')
        .maybeSingle()

      if (error) throw error
      if (!updated) throw new Error('Статусът не беше записан. Опитайте отново.')

      await Promise.all([onChanged(), loadDetail()])
      onResult({
        tone: 'success',
        message: status === 'waiting_approval'
          ? 'Статусът е „Изчаква одобрение“. Натиснете „Изпрати за одобрение“.'
          : `Статусът е променен на „${statusLabels[status]}“.`,
      })
    } catch (error) {
      setStatusChoice(previousStatus)
      onResult({ tone: 'error', message: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const finishTask = async () => {
    if (!canWork || busy) return
    if (!approvedForCompletion) {
      onResult({ tone: 'error', message: 'Задачата изисква одобрение преди да отбележите своята част като завършена.' })
      return
    }

    const confirmText = assigneeCount > 1
      ? 'Сигурни ли сте, че искате да отбележите СВОЯТА част от задачата като завършена? Останалите изпълнители ще запазят собствените си статуси.'
      : 'Сигурни ли сте, че искате да отбележите задачата като завършена?'
    if (!window.confirm(confirmText)) return

    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('complete_task_assignment', { p_task_id: task.id })
      if (error) throw error

      const result = (data || {}) as {
        task_completed?: boolean
        remaining_assignees?: number
      }

      await Promise.all([onChanged(), loadDetail()])
      onResult({
        tone: 'success',
        message: result.task_completed
          ? 'Всички изпълнители приключиха. Задачата е преместена в „Завършени“.'
          : `Вашата част е отбелязана като завършена. Остават ${result.remaining_assignees ?? Math.max(0, assigneeCount - completedAssigneeCount - 1)} изпълнител(и).`,
      })
    } catch (error) {
      onResult({ tone: 'error', message: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const stopRecurrence = async () => {
    if (!task.recurrence_id || !recurrenceActive) return
    if (!window.confirm('Да спра ли бъдещото повторение на тази задача? Вече създадените задачи ще останат.')) return
    setBusy(true)
    const { error } = await supabase.rpc('stop_task_recurrence', { p_recurrence_id: task.recurrence_id })
    setBusy(false)
    if (error) return onResult({ tone: 'error', message: error.message })
    setRecurrenceActive(false)
    onResult({ tone: 'success', message: 'Повторението е спряно. Вече създадените задачи остават без промяна.' })
  }

  const uploadLogicalFile = async (file: File, progressUpdateId: string | null) => {
    const { data: logical, error: logicalError } = await supabase
      .from('logical_files')
      .insert({
        task_id: task.id,
        progress_update_id: progressUpdateId,
        parent_type: progressUpdateId ? 'progress_update' : 'task',
        display_name: file.name,
        created_by: currentUser.id,
      })
      .select('id')
      .single()
    if (logicalError || !logical) throw logicalError || new Error('Файлът не беше регистриран.')

    const path = `${currentUser.id}/${task.id}/${logical.id}/v1-${crypto.randomUUID()}-${safeFileName(file.name)}`
    const { error: storageError } = await supabase.storage.from('task-files').upload(path, file, { upsert: false, contentType: file.type || undefined })
    if (storageError) throw storageError

    const { error: versionError } = await supabase.from('file_versions').insert({
      logical_file_id: logical.id,
      version_number: 1,
      storage_path: path,
      original_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: currentUser.id,
      sha256: await hexDigest(file),
    })
    if (versionError) throw versionError
  }

  const saveTaskEdits = async (event: FormEvent) => {
    event.preventDefault()
    if (!isCreator || !editDescription.trim() || !editDueAt) return

    const effectiveEditDueAt = editScheduleMode === 'interval' ? editEndAt : editDueAt
    if (editScheduleMode === 'interval') {
      const start = new Date(editStartAt)
      const end = new Date(editEndAt)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        onResult({ tone: 'error', message: 'Крайният момент трябва да бъде след началния.' })
        return
      }
    }

    if (editReminderEnabled) {
      const reminderError = validateTaskReminder(editRemindAt, effectiveEditDueAt)
      if (reminderError) {
        onResult({ tone: 'error', message: reminderError })
        return
      }
    }
    setBusy(true)
    const { error } = await supabase.from('tasks').update({
      description: editDescription.trim(),
      due_at: new Date(effectiveEditDueAt).toISOString(),
      starts_at: editScheduleMode === 'interval' ? new Date(editStartAt).toISOString() : null,
      ends_at: editScheduleMode === 'interval' ? new Date(editEndAt).toISOString() : null,
      required_materials: editMaterials.trim() || null,
      approval_required: editApprovalRequired,
    }).eq('id', task.id).eq('created_by', currentUser.id)

    if (error) {
      setBusy(false)
      onResult({ tone: 'error', message: `Задачата не беше редактирана: ${error.message}` })
      return
    }

    try {
      if (editReminderEnabled) {
        const { error: reminderError } = await supabase.from('task_reminders').upsert({
          task_id: task.id,
          created_by: currentUser.id,
          remind_at: new Date(editRemindAt).toISOString(),
          sent_at: null,
          processing_at: null,
          delivery_count: 0,
          last_error: null,
        }, { onConflict: 'task_id' })
        if (reminderError) throw new Error(`Напомнянето не беше записано: ${reminderError.message}`)
      } else {
        const { error: reminderDeleteError } = await supabase.from('task_reminders').delete().eq('task_id', task.id).eq('created_by', currentUser.id)
        if (reminderDeleteError) throw new Error(`Напомнянето не беше премахнато: ${reminderDeleteError.message}`)
      }
      if (task.recurrence_id && recurrenceActive) {
        const { error: recurrenceError } = await supabase.rpc('update_task_recurrence_lead_days', {
          p_recurrence_id: task.recurrence_id,
          p_lead_days: recurrenceLeadDays,
        })
        if (recurrenceError) throw new Error(`Настройката за повторение не беше записана: ${recurrenceError.message}`)
      }
      for (const file of editFiles) await uploadLogicalFile(file, null)
      setEditFiles([])
      setEditing(false)
      await Promise.all([onChanged(), loadDetail()])
      onResult({ tone: 'success', message: 'Промените по задачата са записани.' })
    } catch (supplementError) {
      setEditing(false)
      await Promise.all([onChanged(), loadDetail()])
      onResult({ tone: 'error', message: `Основните промени са записани, но допълнение към задачата не беше записано: ${errorText(supplementError)}` })
    } finally {
      setBusy(false)
    }
  }

  const deleteTask = async () => {
    if (!isCreator || busy || loading) return
    if (!window.confirm(`Да изтрия ли задачата „${task.description}“? Това действие е необратимо.`)) return
    setBusy(true)

    const storagePaths = files.flatMap((file) => (file.file_versions || []).map((version) => version.storage_path))
    if (storagePaths.length > 0) {
      const { error: storageError } = await supabase.storage.from('task-files').remove(storagePaths)
      if (storageError) {
        setBusy(false)
        onResult({ tone: 'error', message: `Задачата не беше изтрита, защото файловете не можаха да бъдат премахнати: ${storageError.message}` })
        return
      }
    }

    const { error } = await supabase.from('tasks').delete().eq('id', task.id).eq('created_by', currentUser.id)
    setBusy(false)
    if (error) {
      onResult({ tone: 'error', message: `Задачата не беше изтрита: ${error.message}` })
      return
    }
    await onChanged()
    onClose()
    onResult({ tone: 'success', message: 'Задачата е изтрита.' })
  }

  const addProgress = async (event: FormEvent) => {
    event.preventDefault()
    if (!updateBody.trim()) return
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('progress_updates')
        .insert({ task_id: task.id, author_id: currentUser.id, body: updateBody.trim() })
        .select('id')
        .single()
      if (error || !data) throw error || new Error('Актуализацията не беше записана.')
      for (const file of updateFiles) await uploadLogicalFile(file, data.id)
      setUpdateBody('')
      setUpdateFiles([])
      await loadDetail()
      onResult({ tone: 'success', message: 'Напредъкът е добавен.' })
    } catch (error) {
      onResult({ tone: 'error', message: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const uploadTaskFiles = async (incoming: FileList | null) => {
    if (!incoming?.length) return
    setBusy(true)
    try {
      for (const file of Array.from(incoming)) await uploadLogicalFile(file, null)
      await loadDetail()
      onResult({ tone: 'success', message: 'Файловете са добавени.' })
    } catch (error) {
      onResult({ tone: 'error', message: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const uploadVersion = async (logical: LogicalFile, file: File) => {
    setBusy(true)
    try {
      const nextVersion = Math.max(0, ...(logical.file_versions || []).map((version) => version.version_number)) + 1
      const path = `${currentUser.id}/${task.id}/${logical.id}/v${nextVersion}-${crypto.randomUUID()}-${safeFileName(file.name)}`
      const { error: storageError } = await supabase.storage.from('task-files').upload(path, file, { upsert: false, contentType: file.type || undefined })
      if (storageError) throw storageError
      const { error } = await supabase.from('file_versions').insert({
        logical_file_id: logical.id,
        version_number: nextVersion,
        storage_path: path,
        original_name: file.name,
        mime_type: file.type || null,
        size_bytes: file.size,
        uploaded_by: currentUser.id,
        sha256: await hexDigest(file),
      })
      if (error) throw error
      await loadDetail()
      onResult({ tone: 'success', message: `Версия ${nextVersion} е добавена, без да се презаписва предишната.` })
    } catch (error) {
      onResult({ tone: 'error', message: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const downloadVersion = async (version: FileVersion) => {
    const { data, error } = await supabase.storage.from('task-files').createSignedUrl(version.storage_path, 60)
    if (error) return onResult({ tone: 'error', message: error.message })
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  const submitApprovalRequest = async (note: string | null = null) => {
    if (busy) return false
    setBusy(true)

    try {
      // The task is already staged as waiting_approval. This RPC creates the
      // real pending request that the governor will receive for a decision.
      const { error } = await supabase.rpc('request_task_approval', {
        p_task_id: task.id,
        p_request_note: note?.trim() || null,
      })
      if (error) throw error

      setApprovalNote('')
      setTab('approvals')
      await Promise.all([loadDetail(), onChanged()])
      onResult({ tone: 'success', message: 'Заявката за одобрение е изпратена към Управителя.' })
      return true
    } catch (error) {
      onResult({ tone: 'error', message: errorText(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const requestApproval = async (event: FormEvent) => {
    event.preventDefault()
    await submitApprovalRequest(approvalNote)
  }

  const decideApproval = async (approval: Approval, status: Exclude<ApprovalStatus, 'pending'>) => {
    if (busy) return
    const note = window.prompt('Бележка към решението (по желание):')
    if (note === null) return

    setBusy(true)
    try {
      // Only the governor can execute this RPC. The decision and task status
      // transition happen atomically in the database.
      const { error } = await supabase.rpc('decide_task_approval', {
        p_approval_id: approval.id,
        p_status: status,
        p_decision_note: note.trim() || null,
      })
      if (error) throw error

      await Promise.all([loadDetail(), onChanged()])
      onResult({ tone: 'success', message: `Решението е записано: ${approvalLabels[status]}.` })
    } catch (error) {
      onResult({ tone: 'error', message: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const taskFiles = files.filter((file) => file.parent_type === 'task')
  const updateFileMap = new Map<string, LogicalFile[]>()
  files.filter((file) => file.progress_update_id).forEach((file) => {
    const current = updateFileMap.get(file.progress_update_id!) || []
    updateFileMap.set(file.progress_update_id!, [...current, file])
  })
  const canStopRecurrence = Boolean(task.recurrence_id && recurrenceActive && (currentUser.role === 'manager' || task.created_by === currentUser.id))
  const latestApproval = approvals[0] || null
  const hasPendingApproval = approvals.some((approval) => approval.status === 'pending')
  const requiresApprovalForCompletion = task.approval_required || statusChoice === 'waiting_approval'
  const approvedForCompletion = !requiresApprovalForCompletion || latestApproval?.status === 'approved'
  const canSendForApproval = Boolean(
    canWork
    && statusChoice === 'waiting_approval'
    && !hasPendingApproval
  )

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Детайли за задача">
        <header className="drawer-header">
          <div className="task-badges"><span className={`priority-badge ${task.priority}`}>{priorityLabels[task.priority]}</span>{isOverdue(task.due_at, task.status) && <span className="overdue-pill">Просрочена</span>}{task.recurrence_id && <span className="approval-badge">↻ Повтаряща се</span>}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isCreator && <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing((value) => !value)}>✎ {editing ? 'Затвори редакцията' : 'Редактирай'}</button>}
            {isCreator && <button type="button" className="danger-soft" disabled={busy || loading} onClick={() => void deleteTask()}>⌫ Изтрий</button>}
            <button className="icon-button" onClick={onClose} aria-label="Затвори">×</button>
          </div>
        </header>
        <div className="drawer-body">
          <h2>{task.description}</h2>
          {editing && isCreator && (
            <form className="stack-form modal-form" onSubmit={saveTaskEdits} style={{ margin: '14px 0 18px', padding: 16, border: '1px solid #d8e3f2', borderRadius: 14, background: '#f8faff' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div><small style={{ display: 'block', color: '#7789a8' }}>Редакция от създателя</small><strong>Променете данните и запазете.</strong></div>
                <span className="approval-badge">Само вие можете да редактирате</span>
              </div>
              <label>Описание<textarea required rows={3} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} /></label>
              <fieldset className="task-schedule-mode">
                <legend>Дата и време</legend>
                <div className="task-schedule-mode-header">
                  <div className="view-switch" aria-label="Режим на дата и час при редакция">
                    <button type="button" className={editScheduleMode === 'deadline' ? 'active' : ''} onClick={() => setEditScheduleMode('deadline')} aria-pressed={editScheduleMode === 'deadline'}>Краен срок</button>
                    <button type="button" className={editScheduleMode === 'interval' ? 'active' : ''} onClick={() => setEditScheduleMode('interval')} aria-pressed={editScheduleMode === 'interval'}>Начало и край</button>
                  </div>
                  <small>{editScheduleMode === 'interval' ? 'Задачата ще се третира като събитие с продължителност.' : 'Задачата има само краен срок.'}</small>
                </div>
                {editScheduleMode === 'interval' ? (
                  <div className="task-schedule-range-grid">
                    <BulgarianDateTimeField value={editStartAt} onChange={setEditStartAt} legend="Начало" previewLabel="Начало на събитието" />
                    <BulgarianDateTimeField value={editEndAt} onChange={setEditEndAt} legend="Край" previewLabel="Край на събитието" />
                  </div>
                ) : (
                  <BulgarianDateTimeField value={editDueAt} onChange={setEditDueAt} />
                )}
              </fieldset>
              <label>Необходими материали<textarea rows={2} value={editMaterials} onChange={(event) => setEditMaterials(event.target.value)} placeholder="Линкове, документи или допълнителна информация" /></label>
              <label className="switch-row"><input type="checkbox" checked={editApprovalRequired} onChange={(event) => setEditApprovalRequired(event.target.checked)} /><span>Необходимо е одобрение преди завършване</span></label>
              {task.recurrence_id && recurrenceActive && (
                <fieldset style={{ padding: 14, border: '1px solid #dbe7f6', borderRadius: 14, background: '#ffffff' }}>
                  <legend style={{ padding: '0 6px', fontWeight: 750 }}>↻ Повторение на задачата</legend>
                  <label>Кога да се създава всеки следващ екземпляр
                    <select value={recurrenceLeadDays} onChange={(event) => setRecurrenceLeadDays(Number(event.target.value))}>
                      {[0, 1, 2, 3, 4].map((days) => (
                        <option key={days} value={days}>
                          {days === 0 ? 'Веднага (0 дни предварително)' : `${recurrenceLeadLabel(days)} преди крайния срок`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <small style={{ display: 'block', marginTop: 7, color: '#71809b' }}>Промяната важи за бъдещите задачи от тази серия. Ако новият момент вече е настъпил, следващият екземпляр ще бъде създаден при най-близката автоматична проверка.</small>
                </fieldset>
              )}
              <fieldset style={{ padding: 14, border: '1px solid #dbe7f6', borderRadius: 14, background: '#ffffff' }}>
                <legend style={{ padding: '0 6px', fontWeight: 750 }}>🔔 Напомняне за задачата</legend>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div className="view-switch" aria-label="Напомняне при редакция">
                    <button type="button" className={!editReminderEnabled ? 'active' : ''} onClick={() => setEditReminderEnabled(false)} aria-pressed={!editReminderEnabled}>Не</button>
                    <button type="button" className={editReminderEnabled ? 'active' : ''} onClick={() => setEditReminderEnabled(true)} aria-pressed={editReminderEnabled}>Да</button>
                  </div>
                  <span style={{ color: '#71809b', fontSize: 12 }}>{reminder?.sent_at ? `Предишното напомняне е изпратено на ${formatDateTime(reminder.sent_at)}.` : 'Получатели са изпълнителите с включени push известия.'}</span>
                </div>
                {editReminderEnabled && <div style={{ marginTop: 14 }}><BulgarianDateTimeField value={editRemindAt} onChange={setEditRemindAt} legend="Изпрати напомнянето" previewLabel="Момент на push известието" /></div>}
              </fieldset>
              <label className="upload-drop">📎 Прикачи допълнителни файлове<input type="file" multiple disabled={busy} onChange={(event) => setEditFiles(Array.from(event.target.files || []))} /></label>
              {editFiles.length > 0 && <small className="selected-files">Избрани: {editFiles.map((file) => file.name).join(', ')}</small>}
              <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)} disabled={busy}>Отказ</button><button className="primary-button" disabled={busy || !editDescription.trim()}>{busy ? 'Запазване…' : 'Запази промените'}</button></div>
            </form>
          )}
          <div className="detail-grid">
            <div>
              <small>Общ статус</small>
              {task.status === 'completed' ? (
                <strong style={{ color: '#1d4ed8' }}>✓ Завършена</strong>
              ) : task.status === 'new' ? (
                <strong style={{ color: '#2563eb' }}>Отворена · чака изпълнителите да я приемат</strong>
              ) : statusChoice === 'waiting_approval' && hasPendingApproval ? (
                <strong style={{ color: '#b7791f' }}>Изчаква одобрение · изпратена към Управителя</strong>
              ) : canParticipate && (!isAssignee || currentAssignment?.work_status === 'in_progress') ? (
                <select value={statusChoice} onChange={(event) => void changeStatus(event.target.value as TaskStatus)} disabled={busy}>
                  {statuses
                    .filter((status) => status !== 'new' && status !== 'completed')
                    .map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
                </select>
              ) : (
                <strong>{statusLabels[task.status]}</strong>
              )}
            </div>

            {isAssignee && task.status !== 'completed' && (
              <div>
                <small>Ваш статус</small>
                {currentAssignment?.work_status === 'new' ? (
                  <div className="personal-assignment-state">
                    <strong className="assignee-state-text new">Неприета</strong>
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void acceptTask()}>
                      {busy ? 'Приемане…' : '✓ Приеми задачата'}
                    </button>
                  </div>
                ) : currentAssignment?.work_status === 'completed' ? (
                  <strong className="assignee-state-text completed">✓ Вашата част е завършена</strong>
                ) : (
                  <strong className="assignee-state-text in_progress">● Работите по задачата</strong>
                )}
              </div>
            )}

            {task.starts_at && task.ends_at ? (
              <>
                <div><small>Начало</small><strong>{formatDateTime(task.starts_at)}</strong></div>
                <div><small>Край</small><strong className={isOverdue(task.due_at, getViewerTaskStatus(task, currentUser.id)) ? 'overdue-text' : ''}>{formatDateTime(task.ends_at)}</strong></div>
              </>
            ) : (
              <div><small>Краен срок</small><strong className={isOverdue(task.due_at, getViewerTaskStatus(task, currentUser.id)) ? 'overdue-text' : ''}>{formatDateTime(task.due_at)}</strong></div>
            )}
            <div><small>Напомняне</small><strong>{reminder ? (reminder.sent_at ? `Изпратено · ${formatDateTime(reminder.sent_at)}` : formatDateTime(reminder.remind_at)) : 'Няма'}</strong></div>
            <div><small>Възложил</small><strong>{task.creator?.display_name || '—'}</strong></div>

            <div className="assignee-status-section">
              <small>Изпълнители · индивидуален статус</small>
              <div className="assignee-status-list">
                {task.assignees.map((person) => {
                  const assignment = assignmentByUser.get(person.id)
                  const workStatus = assignment?.work_status || 'new'
                  return (
                    <span key={person.id} className={`assignee-status-person ${workStatus}`}>
                      <span className="avatar small">{initials(person.display_name)}</span>
                      <span>
                        <strong>{person.display_name}</strong>
                        <small>{assigneeWorkStatusLabels[workStatus]}</small>
                      </span>
                    </span>
                  )
                })}
              </div>
            </div>
          </div>

          {task.status !== 'completed' && canWork && (
            <div className={`task-completion-panel${approvedForCompletion ? '' : ' waiting-approval'}`}>
              <div>
                <small>{assigneeCount > 1 ? 'Приключване на вашата част' : 'Приключване на задачата'}</small>
                <strong>
                  {hasPendingApproval
                    ? 'Задачата е изпратена за одобрение и чака решение от Управителя.'
                    : statusChoice === 'waiting_approval'
                      ? 'Задачата е в „Изчаква одобрение“. Изпратете я към Управителя.'
                      : approvedForCompletion
                        ? assigneeCount > 1
                          ? 'Когато вашата работа е готова, отбележете само своята част като завършена.'
                          : 'Когато работата е готова, отбележете задачата като завършена.'
                        : 'Преди завършване задачата трябва да бъде одобрена.'}
                </strong>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {canSendForApproval && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void submitApprovalRequest()}
                  >
                    ✓ Изпрати за одобрение
                  </button>
                )}
                <button type="button" className="success-button complete-task-button" disabled={busy || !approvedForCompletion} onClick={() => void finishTask()}>
                  {assigneeCount > 1 ? '✓ Завърши моята част' : '✓ Завърши задачата'}
                </button>
              </div>
            </div>
          )}

          {task.status !== 'completed' && currentAssignment?.work_status === 'completed' && (
            <div className="assignment-completed-panel">
              <span>✓</span>
              <div>
                <small>Вашата работа е приключена</small>
                <strong>
                  Вашата част е завършена. Общата задача ще приключи, когато всички изпълнители завършат своите части.
                  {assigneeCount > completedAssigneeCount ? ` Остават ${assigneeCount - completedAssigneeCount}.` : ''}
                </strong>
              </div>
            </div>
          )}

          {task.status === 'completed' && (
            <div className="task-completed-panel"><span>✓</span><div><small>Задачата е приключена</small><strong>Всички изпълнители са приключили и задачата се намира в категория „Завършени“.</strong></div></div>
          )}

          {task.status !== 'completed' && currentAssignment?.work_status === 'new' && (
            <div className="assignment-awaiting-panel">
              <small>Ваш работен поток</small>
              <strong>Задачата може вече да е започната от друг изпълнител, но при вас остава „Неприета“, докато лично не натиснете „Приеми задачата“.</strong>
            </div>
          )}
          {task.recurrence_id && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', background: recurrenceActive ? '#eef4ff' : '#f4f6f6', border: `1px solid ${recurrenceActive ? '#d3e2f7' : '#e0e5e5'}`, borderRadius: 12 }}>
              <div><small style={{ display: 'block', color: '#7789a8', marginBottom: 3 }}>Повторение</small><strong style={{ color: recurrenceActive ? '#1d4ed8' : '#778688' }}>{recurrenceActive ? `Активно — бъдещите задачи ще се създават ${recurrenceLeadLabel(recurrenceLeadDays)} преди крайния срок.` : 'Спряно — няма да се създават нови задачи от тази серия.'}</strong></div>
              {canStopRecurrence && <button type="button" className="danger-soft" disabled={busy} onClick={() => void stopRecurrence()}>Спри повторението</button>}
            </div>
          )}
          {task.required_materials && <div className="materials"><small>Необходими материали</small><p>{task.required_materials}</p></div>}

          <nav className="detail-tabs" aria-label="Секции">
            {([
              ['progress', 'Напредък', updates.length],
              ['files', 'Файлове', taskFiles.length],
              ['approvals', 'Одобрения', approvals.length],
              ['activity', 'Дневник', activity.length],
            ] as [DetailTab, string, number][]).map(([id, label, count]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}<span>{count}</span></button>
            ))}
          </nav>

          {loading ? <InlineLoader /> : tab === 'progress' ? (
            <section className="detail-section">
              {canWork && (
                <form className="update-composer" onSubmit={addProgress}>
                  <textarea rows={3} required value={updateBody} onChange={(event) => setUpdateBody(event.target.value)} placeholder="Добавете актуализация за напредъка…" />
                  <div><label className="file-button">📎 Файлове<input type="file" multiple onChange={(event) => setUpdateFiles(Array.from(event.target.files || []))} /></label><span className="selected-files">{updateFiles.map((file) => file.name).join(', ')}</span><button className="primary-button" disabled={busy}>Добави</button></div>
                </form>
              )}
              <div className="timeline">
                {updates.map((update) => (
                  <article key={update.id}>
                    <span className="timeline-dot" />
                    <div className="timeline-card">
                      <div className="timeline-author"><span className="avatar small">{initials(byId.get(update.author_id)?.display_name || 'А')}</span><strong>{byId.get(update.author_id)?.display_name || 'Неизвестен'}</strong><time>{formatDateTime(update.created_at)}</time></div>
                      <p>{update.body}</p>
                      {(updateFileMap.get(update.id) || []).map((file) => <FileRow key={file.id} file={file} compact canUpload={canWork} busy={busy} onDownload={downloadVersion} onVersion={uploadVersion} />)}
                    </div>
                  </article>
                ))}
                {updates.length === 0 && <EmptySmall text={currentAssignment?.work_status === 'new' ? 'Вие още не сте приели задачата. Напредък може да добавяте след лично приемане.' : 'Все още няма актуализации.'} />}
              </div>
            </section>
          ) : tab === 'files' ? (
            <section className="detail-section">
              {canManageFiles && <label className="upload-drop">＋ Добави файлове към задачата<input type="file" multiple disabled={busy} onChange={(event) => void uploadTaskFiles(event.target.files)} /></label>}
              <div className="file-list">{taskFiles.map((file) => <FileRow key={file.id} file={file} canUpload={canManageFiles} busy={busy} onDownload={downloadVersion} onVersion={uploadVersion} />)}{taskFiles.length === 0 && <EmptySmall text={currentAssignment?.work_status === 'new' && !isCreator ? 'Файлове можете да добавяте след като лично приемете задачата.' : 'Няма файлове към задачата.'} />}</div>
            </section>
          ) : tab === 'approvals' ? (
            <section className="detail-section">
              {canSendForApproval && (
                <form className="approval-request" onSubmit={requestApproval}><input value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder="Бележка към заявката (по желание)" /><button className="primary-button" disabled={busy}>Изпрати за одобрение</button></form>
              )}
              <div className="approval-list">
                {approvals.map((approval) => (
                  <article key={approval.id}>
                    <div><span className={`approval-state ${approval.status}`}>{approvalLabels[approval.status]}</span><time>{formatDateTime(approval.requested_at)}</time></div>
                    <p><strong>{byId.get(approval.requested_by)?.display_name || 'Потребител'}</strong>{approval.request_note ? `: ${approval.request_note}` : ' изпрати задача за одобрение.'}</p>
                    {approval.decision_note && <blockquote>{approval.decision_note}</blockquote>}
                    {approval.status === 'pending' && currentUser.display_role === 'Управител' && <div className="approval-actions"><button disabled={busy} onClick={() => void decideApproval(approval, 'changes_requested')}>Върни за промени</button><button className="danger-soft" disabled={busy} onClick={() => void decideApproval(approval, 'rejected')}>Отхвърли</button><button className="success-button" disabled={busy} onClick={() => void decideApproval(approval, 'approved')}>Одобри</button></div>}
                  </article>
                ))}
                {approvals.length === 0 && <EmptySmall text={task.status === 'new' ? 'Одобрение може да се заяви след приемане на задачата.' : 'Все още няма заявка за одобрение. Изпратете задачата за одобрение, когато е готова за преглед.'} />}
              </div>
            </section>
          ) : (
            <section className="detail-section activity-list">
              {activity.map((entry) => (
                <article key={entry.id}><span className="activity-icon">↻</span><div><p><strong>{byId.get(entry.actor_id || '')?.display_name || 'Система'}</strong> · {actionLabels[entry.action] || entry.action} {entityLabels[entry.entity_type] || entry.entity_type}</p><time>{formatDateTime(entry.created_at)}</time></div></article>
              ))}
              {activity.length === 0 && <EmptySmall text="Дневникът е празен." />}
            </section>
          )}
        </div>
      </aside>
    </div>
  )
}

function FileRow({
  file,
  compact = false,
  canUpload,
  busy,
  onDownload,
  onVersion,
}: {
  file: LogicalFile
  compact?: boolean
  canUpload: boolean
  busy: boolean
  onDownload: (version: FileVersion) => Promise<void>
  onVersion: (logical: LogicalFile, file: File) => Promise<void>
}) {
  const versions = [...(file.file_versions || [])].sort((a, b) => b.version_number - a.version_number)
  const latest = versions[0]
  return (
    <div className={`file-row ${compact ? 'compact' : ''}`}>
      <span className="file-icon">▤</span>
      <div><strong>{file.display_name}</strong><small>{latest ? `Версия ${latest.version_number} · ${fileSize(latest.size_bytes)}` : 'Без качена версия'}</small></div>
      {latest && <button className="text-button" onClick={() => void onDownload(latest)}>Изтегли</button>}
      {canUpload && <label className="version-button">Нова версия<input type="file" disabled={busy} onChange={(event) => event.target.files?.[0] && void onVersion(file, event.target.files[0])} /></label>}
      {versions.length > 1 && <details><summary>{versions.length} версии</summary><div>{versions.map((version) => <button key={version.id} onClick={() => void onDownload(version)}>v{version.version_number} · {formatDateTime(version.uploaded_at)}</button>)}</div></details>}
    </div>
  )
}

type WebPushPlatform = 'ios' | 'ipados' | 'macos' | 'windows' | 'android' | 'linux' | 'other'

function detectWebPushPlatform(): WebPushPlatform {
  const ua = navigator.userAgent || ''
  const nav = navigator as Navigator & { platform?: string; maxTouchPoints?: number }
  if (/iPhone|iPod/i.test(ua)) return 'ios'
  if (/iPad/i.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1)) return 'ipados'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Android/i.test(ua)) return 'android'
  if (/Linux/i.test(ua)) return 'linux'
  return 'other'
}

function isStandaloneWebApp() {
  const nav = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true
}

function PushButton({ userId, onResult }: { userId: string; onResult: (toast: Toast) => void }) {
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(false)
  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  const platform = useMemo(() => detectWebPushPlatform(), [])
  const standalone = isStandaloneWebApp()
  const appleMobileNeedsInstall = (platform === 'ios' || platform === 'ipados') && !standalone
  const supported = !appleMobileNeedsInstall
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window

  const saveSubscription = useCallback(async (subscription: PushSubscription) => {
    const json = subscription.toJSON()
    if (!json.keys?.p256dh || !json.keys.auth) throw new Error('Браузърът не връща валиден push абонамент.')

    const { error } = await supabase.rpc('claim_push_subscription', {
      p_endpoint: subscription.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_user_agent: navigator.userAgent,
      p_platform: platform,
      p_standalone: standalone,
    })

    if (error) throw error
  }, [platform, standalone, userId])

  useEffect(() => {
    if (!supported || !vapidKey || Notification.permission !== 'granted') return
    let cancelled = false

    const sync = async () => {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      const ready = await navigator.serviceWorker.ready
      let subscription = await ready.pushManager.getSubscription()

      if (!subscription) {
        subscription = await ready.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        })
      }

      await saveSubscription(subscription)
      if (!cancelled) setActive(true)
      void registration.update().catch(() => undefined)
    }

    void sync().catch(() => {
      if (!cancelled) setActive(false)
    })

    return () => { cancelled = true }
  }, [saveSubscription, supported, vapidKey])

  const enable = async () => {
    if (busy) return

    if (appleMobileNeedsInstall) {
      onResult({
        tone: 'error',
        message: 'На iPhone/iPad първо добавете сайта на Home Screen: Safari → Споделяне → Add to Home Screen. После отворете приложението от иконата и включете известията.',
      })
      return
    }

    if (!supported || !vapidKey) {
      onResult({ tone: 'error', message: 'Този браузър не поддържа Web Push известия или push конфигурацията липсва.' })
      return
    }

    if (Notification.permission === 'denied') {
      onResult({ tone: 'error', message: 'Известията са блокирани в системните настройки за този сайт/приложение.' })
      return
    }

    setBusy(true)
    try {
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission()

      if (permission !== 'granted') throw new Error('Разрешението за известия не е дадено.')

      await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      const registration = await navigator.serviceWorker.ready
      const existingSubscription = await registration.pushManager.getSubscription()
      const subscription = existingSubscription || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })

      await saveSubscription(subscription)
      setActive(true)

      const deviceLabel = platform === 'ios'
        ? 'iPhone'
        : platform === 'ipados'
          ? 'iPad'
          : platform === 'macos'
            ? 'Mac'
            : 'този браузър'

      onResult({
        tone: 'success',
        message: existingSubscription
          ? `Push известията вече са активни за ${deviceLabel}.`
          : `Push известията са активирани за ${deviceLabel}.`,
      })
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'Service worker-ът не успя да се активира. Обновете страницата и опитайте отново.'
        : errorText(error)
      onResult({ tone: 'error', message })
    } finally {
      setBusy(false)
    }
  }

  const buttonLabel = busy
    ? 'Активиране…'
    : active
      ? 'Известия активни'
      : appleMobileNeedsInstall
        ? 'iPhone известия'
        : 'Известия'

  return (
    <button
      className={`notification-button${active ? ' active' : ''}`}
      onClick={() => void enable()}
      disabled={busy}
      title={active
        ? 'Push известията са активни'
        : appleMobileNeedsInstall
          ? 'Добавете сайта на Home Screen, за да активирате известия на iPhone/iPad'
          : 'Активирай push известия'}
    >
      {active ? '●' : appleMobileNeedsInstall ? '◫' : '♢'}<span>{buttonLabel}</span>
    </button>
  )
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)))
}

function Modal({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Затвори">×</button></header>
        {children}
      </section>
    </div>
  )
}

function EmptySmall({ text }: { text: string }) {
  return <div className="empty-small"><span>○</span><p>{text}</p></div>
}

function FullPageLoader() {
  return <div className="full-loader"><span className="spinner" /><p>Зареждане…</p></div>
}

function InlineLoader() {
  return <div className="inline-loader"><span className="spinner" /> Зареждане…</div>
}

function FatalConfiguration({ message }: { message: string }) {
  return <main className="fatal"><div><strong>Липсва конфигурация</strong><p>{message}</p></div></main>
}

export default App
