import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configurationError } from './lib/supabase'
import ChecklistDrawer from './ChecklistDrawer'
import {
  approvalLabels,
  bulgarianDateKey,
  formatDateTime,
  formatBulgarianDateLong,
  formatBulgarianTime,
  initials,
  isOverdue,
  priorities,
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
  Priority,
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
type TaskReminder = {
  id: string
  task_id: string
  created_by: string
  remind_at: string
  sent_at: string | null
  delivery_count: number
  last_error: string | null
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
const recurrenceLeadLabel = (days: number) => days === 1 ? '1 ден' : `${days} дни`

const taskCategoryOrder: TaskCategory[] = ['open', 'active', 'approval', 'overdue', 'completed']
const taskCategoryMeta: Record<TaskCategory, { label: string; tone: string; icon: string }> = {
  open: { label: 'Отворени', tone: 'teal', icon: '□' },
  active: { label: 'В процес', tone: 'blue', icon: '↻' },
  approval: { label: 'За одобрение', tone: 'amber', icon: '✓' },
  overdue: { label: 'Просрочени', tone: 'red', icon: '!' },
  completed: { label: 'Завършени', tone: 'green', icon: '✓' },
}

const getTaskCategory = (task: TaskView): TaskCategory => {
  if (task.status === 'completed') return 'completed'
  if (isOverdue(task.due_at, task.status)) return 'overdue'
  if (task.status === 'new') return 'open'
  if (task.status === 'waiting_approval') return 'approval'
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

const needsInitialPassword = (session: Session | null) => Boolean(
  session?.user.invited_at && session.user.user_metadata?.password_initialized !== true,
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
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const today = new Date()
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [checklistsOpen, setChecklistsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [categoryFocus, setCategoryFocus] = useState<TaskCategory | null>(null)
  const [managerVisibilityMode, setManagerVisibilityMode] = useState<ManagerVisibilityMode>('all')
  const [visibilityBusy, setVisibilityBusy] = useState(false)

  const showToast = useCallback((next: Toast) => {
    setToast(next)
    window.setTimeout(() => setToast(null), 4500)
  }, [])

  const loadCore = useCallback(async () => {
    if (!session?.user.id) return
    setLoading(true)

    const [profilesResult, tasksResult, assigneesResult, visibilityResult] = await Promise.all([
      supabase.from('profiles').select('*').order('display_name'),
      supabase.from('tasks').select('*').order('due_at'),
      supabase.from('task_assignees').select('*'),
      supabase.from('task_visibility_settings').select('manager_mode').eq('id', 'global').maybeSingle(),
    ])

    const firstError = profilesResult.error || tasksResult.error || assigneesResult.error || visibilityResult.error
    if (firstError) {
      showToast({ tone: 'error', message: firstError.message })
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
    setTasks(
      rawTasks.map((task) => ({
        ...task,
        creator: byId.get(task.created_by),
        assignees: nextAssignees
          .filter((assignment) => assignment.task_id === task.id)
          .map((assignment) => byId.get(assignment.user_id))
          .filter((person): person is Profile => Boolean(person)),
      })),
    )
    setLoading(false)
  }, [session?.user.id, showToast])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
      if (needsInitialPassword(data.session)) setPasswordOpen(true)
    })
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
      if (event === 'PASSWORD_RECOVERY' || needsInitialPassword(nextSession)) setPasswordOpen(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      setProfiles([])
      setTasks([])
      setManagerVisibilityMode('all')
      setLoading(false)
      return
    }
    void loadCore()
  }, [session, loadCore])

  useEffect(() => {
    if (!session) return
    const channel = supabase
      .channel('core-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, loadCore)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignees' }, loadCore)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'task_visibility_settings' }, loadCore)
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [session, loadCore])

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('bg-BG')
    return tasks.filter((task) => {
      if (needle && !task.description.toLocaleLowerCase('bg-BG').includes(needle)) return false
      if (statusFilter !== 'all' && task.status !== statusFilter) return false
      if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false
      if (assigneeFilter !== 'all' && !task.assignees.some((person) => person.id === assigneeFilter)) return false
      if (overdueOnly && !isOverdue(task.due_at, task.status)) return false
      return true
    })
  }, [tasks, query, statusFilter, priorityFilter, assigneeFilter, overdueOnly])

  const categorizedTasks = useMemo(() => {
    const groups: Record<TaskCategory, TaskView[]> = { open: [], active: [], approval: [], overdue: [], completed: [] }
    filteredTasks.forEach((task) => {
      groups[getTaskCategory(task)].push(task)
    })
    return groups
  }, [filteredTasks])

  const counts = useMemo(() => {
    const next: Record<TaskCategory, number> = { open: 0, active: 0, approval: 0, overdue: 0, completed: 0 }
    tasks.forEach((task) => {
      next[getTaskCategory(task)] += 1
    })
    return next
  }, [tasks])

  const visibleCategoryKeys: TaskCategory[] = categoryFocus ? [categoryFocus] : taskCategoryOrder
  const visibleListCount = visibleCategoryKeys.reduce((total, category) => total + categorizedTasks[category].length, 0)
  const canControlManagerVisibility = Boolean(profile && (profile.role === 'admin' || profile.display_role === 'Управител'))

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

  const focusTaskCategory = (category: TaskCategory) => {
    setDashboardView('list')
    setStatusFilter('all')
    setOverdueOnly(false)
    setCategoryFocus((current) => current === category ? null : category)
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
    if (profile.role === 'manager') setCalendarChoiceDate(dueDate)
    else setCreateMode('personal')
  }

  if (configurationError) return <FatalConfiguration message={configurationError} />
  if (!authReady) return <FullPageLoader />
  if (!session) return <Login />

  return (
    <div className="app-shell">
      <AmbientBackground />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">M</span>
          <div>
            <strong>Управленски задачи</strong>
            <small>Вътрешна система</small>
          </div>
        </div>
        <div className="account-area">
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
          <button className="notification-button checklist-launch" onClick={() => setChecklistsOpen(true)} title="Отвори чеклистите">▦<span>Чеклисти</span></button>
          <PushButton userId={session.user.id} onResult={showToast} />
          <button className="notification-button" onClick={() => setPasswordOpen(true)} title="Смени паролата">⌘<span>Парола</span></button>
          <span className="avatar" aria-hidden="true">{initials(profile?.display_name || session.user.email || 'А')}</span>
          <div className="account-copy">
            <strong>{profile?.display_name || session.user.email}</strong>
            <small>{profile?.display_role || (profile?.role === 'manager' ? 'Мениджър' : 'Модератор')}</small>
          </div>
          <button className="icon-button" onClick={() => void supabase.auth.signOut()} aria-label="Изход" title="Изход">↗</button>
        </div>
      </header>

      <main>
        <section className="page-heading dashboard-hero">
          <div className="hero-copy">
            <p className="eyebrow">Общ преглед</p>
            <h1>Задачи на екипа</h1>
            <p>Всички задачи, срокове и решения на едно място.</p>
            <span className="hero-live"><i /> Синхронизирано в реално време</span>
          </div>
          {profile && (
            <div className="page-actions">
              <button className="secondary-button" onClick={() => openCreate('personal')} title="Създай лична задача"><span>＋</span> Лична задача</button>
              {profile.role === 'manager' && (
                <button className="primary-button" onClick={() => openCreate('team')} title="Създай екипна задача"><span>＋</span> Екипна задача</button>
              )}
            </div>
          )}
          <div className="hero-art manager-hero-art" aria-hidden="true">
            <span className="hero-signal signal-a" />
            <span className="hero-signal signal-b" />
            <span className="hero-signal signal-c" />
            <span className="hero-data-bar bar-a" />
            <span className="hero-data-bar bar-b" />
            <span className="hero-data-bar bar-c" />
            <span className="hero-data-bar bar-d" />
          </div>
        </section>

        <section className="stat-grid" aria-label="Категории задачи">
          <StatCard label="Отворени" value={counts.open} tone="teal" icon="□" active={categoryFocus === 'open'} onClick={() => focusTaskCategory('open')} />
          <StatCard label="В процес" value={counts.active} tone="blue" icon="↻" active={categoryFocus === 'active'} onClick={() => focusTaskCategory('active')} />
          <StatCard label="За одобрение" value={counts.approval} tone="amber" icon="✓" active={categoryFocus === 'approval'} onClick={() => focusTaskCategory('approval')} />
          <StatCard label="Просрочени" value={counts.overdue} tone="red" icon="!" active={categoryFocus === 'overdue'} onClick={() => focusTaskCategory('overdue')} />
          <StatCard label="Завършени" value={counts.completed} tone="green" icon="✓" active={categoryFocus === 'completed'} onClick={() => focusTaskCategory('completed')} />
        </section>

        <section className="panel task-panel">
          <div className="filters">
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Търси в описанието…" />
            </label>
            <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as 'all' | TaskStatus); setCategoryFocus(null) }} aria-label="Статус">
              <option value="all">Всички статуси</option>
              {statuses.filter((status) => status !== 'completed').map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
            </select>
            <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as 'all' | Priority)} aria-label="Приоритет">
              <option value="all">Всички приоритети</option>
              {priorities.map((priority) => <option key={priority} value={priority}>{priorityLabels[priority]}</option>)}
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
            <h2>{categoryFocus ? taskCategoryMeta[categoryFocus].label : 'Задачи по категории'} <span>{visibleListCount}</span></h2>
            <div className="panel-actions">
              {categoryFocus && <button className="text-button" onClick={() => setCategoryFocus(null)}>Всички категории</button>}
              <div className="view-switch" aria-label="Изглед на задачите">
                <button className={dashboardView === 'list' ? 'active' : ''} onClick={() => setDashboardView('list')} aria-pressed={dashboardView === 'list'}>Списък</button>
              </div>
              <button className="text-button" onClick={() => void loadCore()}>Обнови</button>
            </div>
          </div>

          {loading ? (
            <InlineLoader />
          ) : dashboardView === 'calendar' ? (
            <CalendarView
              tasks={filteredTasks}
              cursor={calendarCursor}
              onCursorChange={setCalendarCursor}
              onOpen={(taskId) => setSelectedTaskId(taskId)}
              onCreate={openCalendarCreate}
            />
          ) : visibleListCount === 0 ? (
            <div className="empty-state">
              <span>✓</span>
              <h3>Няма задачи по тези критерии</h3>
              <p>Променете филтрите или създайте нова задача.</p>
            </div>
          ) : (
            <div className="task-board-shell">
              <div className={`task-board${categoryFocus ? ' focused' : ''}`}>
                {visibleCategoryKeys.map((category) => (
                  <TaskCategoryColumn
                    key={category}
                    category={category}
                    tasks={categorizedTasks[category]}
                    onOpen={(taskId) => setSelectedTaskId(taskId)}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      {calendarChoiceDate && profile?.role === 'manager' && (
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

      {createMode && profile && (createMode === 'personal' || profile.role === 'manager') && (
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
          onRecurringCreated={async (taskId) => {
            setCreateMode(null)
            setCreateDueDate(null)
            await loadCore()
            setSelectedTaskId(taskId)
            showToast({ tone: 'success', message: 'Повтарящата се задача е създадена. Следващите задачи ще се създават автоматично по зададения график.' })
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

      {checklistsOpen && profile && (
        <ChecklistDrawer
          currentUser={profile}
          profiles={profiles}
          onClose={() => setChecklistsOpen(false)}
          onResult={showToast}
        />
      )}

      {toast && <div className={`toast ${toast.tone}`} role="status">{toast.message}</div>}
    </div>
  )
}

function AmbientBackground({ className = '' }: { className?: string }) {
  return (
    <div className={`ambient-background manager-ambient ${className}`.trim()} aria-hidden="true">
      <span className="manager-grid" />
      <span className="manager-streak streak-one" />
      <span className="manager-streak streak-two" />
      <span className="manager-streak streak-three" />
      <span className="manager-pulse pulse-one" />
      <span className="manager-pulse pulse-two" />
      <span className="manager-node manager-node-one" />
      <span className="manager-node manager-node-two" />
      <span className="manager-node manager-node-three" />
      <span className="manager-node manager-node-four" />
    </div>
  )
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [resetSent, setResetSent] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setMessage('Невалиден имейл или парола.')
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
      redirectTo: window.location.origin,
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
      <AmbientBackground className="login-ambient" />
      <aside className="login-accent manager-login-hero" aria-hidden="true">
        <div className="executive-showcase">
          <div className="executive-kicker"><span /> MANAGER CONTROL</div>
          <div className="executive-title">
            <small>ЯВЛЕНА · ИЗТОК</small>
            <h2>Управление без<br /><em>излишен шум.</em></h2>
            <p>Център за задачи, отговорности, срокове и решения на управленския екип.</p>
          </div>

          <div className="executive-board">
            <div className="executive-board-head">
              <span>УПРАВЛЕНСКИ ПУЛС</span>
              <b>LIVE</b>
            </div>
            <div className="executive-metrics">
              <div><strong>8</strong><small>активни профила</small></div>
              <div><strong>24/7</strong><small>синхронизация</small></div>
              <div><strong>1</strong><small>общ контролен център</small></div>
            </div>
            <div className="executive-flow">
              <span className="flow-line" />
              <i className="flow-dot dot-a" />
              <i className="flow-dot dot-b" />
              <i className="flow-dot dot-c" />
              <i className="flow-dot dot-d" />
              <div className="flow-label label-a"><b>ЗАДАЧА</b><small>Възлагане</small></div>
              <div className="flow-label label-b"><b>КОНТРОЛ</b><small>Проследяване</small></div>
              <div className="flow-label label-c"><b>РЕШЕНИЕ</b><small>Одобрение</small></div>
            </div>
          </div>

          <div className="executive-meta">
            <span>Роли и права</span>
            <span>Мобилни известия</span>
            <span>История на действията</span>
          </div>
        </div>
      </aside>

      <section className="login-card manager-login-card">
        <span className="manager-login-badge">ВЪТРЕШНА УПРАВЛЕНСКА СИСТЕМА</span>
        <div className="brand login-brand">
          <span className="brand-mark">M</span>
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
    <button type="button" className={`stat-card ${tone}${active ? ' active' : ''}`} onClick={onClick} aria-pressed={active}>
      <div><span className="stat-icon">{icon}</span><p>{label}</p></div>
      <strong>{value}</strong>
    </button>
  )
}

function TaskCategoryColumn({
  category,
  tasks,
  onOpen,
}: {
  category: TaskCategory
  tasks: TaskView[]
  onOpen: (taskId: string) => void
}) {
  const meta = taskCategoryMeta[category]
  return (
    <section className={`task-category-column ${meta.tone}`} aria-label={`${meta.label}: ${tasks.length} задачи`}>
      <header className="task-category-header">
        <div><span className="stat-icon">{meta.icon}</span><strong>{meta.label}</strong></div>
        <span>{tasks.length}</span>
      </header>
      <div className="task-category-list">
        {tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => onOpen(task.id)} />)}
        {tasks.length === 0 && <div className="task-category-empty"><span>○</span><small>Няма задачи</small></div>}
      </div>
    </section>
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
  cursor,
  onCursorChange,
  onOpen,
  onCreate,
}: {
  tasks: TaskView[]
  cursor: Date
  onCursorChange: (date: Date) => void
  onOpen: (taskId: string) => void
  onCreate: (date: Date) => void
}) {
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

  tasks.forEach((task) => {
    const key = bulgarianDateKey(task.due_at)
    tasksByDay.set(key, [...(tasksByDay.get(key) || []), task])
  })

  const moveMonth = (step: number) => onCursorChange(new Date(year, month + step, 1))
  const showToday = () => {
    const today = new Date()
    onCursorChange(new Date(today.getFullYear(), today.getMonth(), 1))
  }

  return (
    <div className="calendar-shell">
      <div className="calendar-toolbar">
        <h3>{bulgarianMonths[month]} {year}</h3>
        <span className="calendar-hint">Български календар · Понеделник–Неделя · 24 часа</span>
        <div>
          <button type="button" onClick={() => moveMonth(-1)} aria-label="Предишен месец">‹</button>
          <button type="button" onClick={showToday}>Днес</button>
          <button type="button" onClick={() => moveMonth(1)} aria-label="Следващ месец">›</button>
        </div>
      </div>
      <div className="calendar-scroll">
        <div className="calendar-grid">
          {bulgarianWeekdays.map((weekday) => <div key={weekday} className="calendar-weekday">{weekday}</div>)}
          {days.map((date) => {
            const key = localDateKey(date)
            const dayTasks = tasksByDay.get(key) || []
            const isOutside = date.getMonth() !== month
            const isToday = key === todayKey

            return (
              <div key={key} className={`calendar-day${isOutside ? ' outside-month' : ''}${isToday ? ' today' : ''}`}>
                <div className="calendar-date">
                  <button
                    type="button"
                    className="calendar-date-button"
                    onClick={() => onCreate(date)}
                    aria-label={`Създай задача за ${formatBulgarianDateLong(date)}`}
                    title={`${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`}
                  >
                    <span>{date.getDate()}</span>
                    {dayTasks.length > 0 && <small>{dayTasks.length}</small>}
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
                  {dayTasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      className={`calendar-task ${task.priority}${isOverdue(task.due_at, task.status) ? ' overdue' : ''}`}
                      onClick={() => onOpen(task.id)}
                      title={`${formatDateTime(task.due_at)} — ${task.description}`}
                    >
                      <time>{formatBulgarianTime(task.due_at)}</time>
                      <span>{task.description}</span>
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

function TaskCard({ task, onOpen }: { task: TaskView; onOpen: () => void }) {
  const overdue = isOverdue(task.due_at, task.status)
  return (
    <button className="task-card" onClick={onOpen}>
      <span className={`priority-bar ${task.priority}`} />
      <div className="task-main">
        <div className="task-badges">
          <span className={`status-badge ${task.status}`}>{statusLabels[task.status]}</span>
          <span className={`priority-badge ${task.priority}`}>{priorityLabels[task.priority]}</span>
          {task.approval_required && <span className="approval-badge">Нужно одобрение</span>}
          {task.recurrence_id && <span className="approval-badge">↻ Повтаряща се</span>}
        </div>
        <h3>{task.description}</h3>
        <div className="task-meta">
          <span className={overdue ? 'overdue-text' : ''}>◷ {formatDateTime(task.due_at)}</span>
          <span>Възложил: {task.creator?.display_name || '—'}</span>
        </div>
      </div>
      <div className="assignee-stack" aria-label={`Изпълнители: ${task.assignees.map((person) => person.display_name).join(', ')}`}>
        {task.assignees.map((person) => <span key={person.id} title={person.display_name}>{initials(person.display_name)}</span>)}
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
      <div className="bulgarian-datetime-preview">
        <span>◷</span>
        <div><small>{previewLabel}</small><strong>{String(day).padStart(2, '0')}.{String(month).padStart(2, '0')}.{year} г. · {String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')} ч.</strong></div>
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
  onRecurringCreated: (taskId: string) => Promise<void>
  onError: (message: string) => void
}) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
  tomorrow.setHours(17, 0, 0, 0)
  const initialSchedule = initialDueDate || tomorrow
  const initialWeekday = initialSchedule.getDay() === 0 ? 7 : initialSchedule.getDay()
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState(dateTimeLocalValue(initialSchedule))
  const [priority, setPriority] = useState<Priority>('normal')
  const [materials, setMaterials] = useState('')
  const [approvalRequired, setApprovalRequired] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [attachments, setAttachments] = useState<File[]>([])
  const [reminderEnabled, setReminderEnabled] = useState(false)
  const [remindAt, setRemindAt] = useState(() => defaultReminderForDue(dateTimeLocalValue(initialSchedule)))
  const [recurring, setRecurring] = useState(false)
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceFrequency>('weekly')
  const [recurrenceWeekday, setRecurrenceWeekday] = useState(initialWeekday)
  const [recurrenceMonthDay, setRecurrenceMonthDay] = useState(initialSchedule.getDate())
  const [recurrenceLeadDays, setRecurrenceLeadDays] = useState(1)
  const [busy, setBusy] = useState(false)
  const personal = mode === 'personal'

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
    if (!personal && (selected.length < 1 || selected.length > 3)) {
      onError('Изберете между един и трима изпълнители.')
      return
    }
    if (reminderEnabled && !recurring) {
      const reminderError = validateTaskReminder(remindAt, dueAt)
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
        p_priority: priority,
        p_required_materials: materials.trim() || null,
        p_approval_required: approvalRequired,
        p_assignee_ids: personal ? [profile.id] : selected,
        p_personal: personal,
        p_frequency: recurrenceFrequency,
        p_start_date: startDate,
        p_time_local: `${localTime}:00`,
        p_weekday: recurrenceFrequency === 'weekly' ? recurrenceWeekday : null,
        p_month_day: recurrenceFrequency === 'monthly' ? recurrenceMonthDay : null,
        p_lead_days: recurrenceLeadDays,
      })

      if (error || !data) {
        onError(error?.message || 'Повтарящата се задача не беше създадена.')
        setBusy(false)
        return
      }
      await onRecurringCreated(data as string)
      return
    }

    const { data, error } = await supabase.rpc('create_task_with_assignees', {
      p_description: description.trim(),
      p_due_at: new Date(dueAt).toISOString(),
      p_priority: priority,
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

  const recurrenceDescription = recurrenceFrequency === 'daily'
    ? `Всеки ден · ${recurrenceLeadLabel(recurrenceLeadDays)} предварително`
    : recurrenceFrequency === 'weekly'
      ? `Всяка седмица · ${bulgarianWeekdays[recurrenceWeekday - 1]} · ${recurrenceLeadLabel(recurrenceLeadDays)} предварително`
      : `Всеки месец · ${recurrenceMonthDay}-во/число · ${recurrenceLeadLabel(recurrenceLeadDays)} предварително`

  return (
    <Modal title={personal ? 'Нова лична задача' : 'Нова екипна задача'} onClose={onClose}>
      <form onSubmit={submit} className="stack-form modal-form">
        <label>Описание<textarea required rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Какво трябва да бъде изпълнено?" /></label>
        <div className="task-scheduling-grid">
          <BulgarianDateTimeField
            value={dueAt}
            onChange={setDueAt}
            legend={recurring ? 'Първи срок' : 'Краен срок'}
            previewLabel={recurring ? 'Първата задача се създава веднага с този срок' : 'Точен срок за България'}
          />
          <label>Приоритет<select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{priorities.map((item) => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select></label>
        </div>

        <fieldset style={{ padding: 14, border: '1px solid #dbe7f6', borderRadius: 14, background: '#f8faff' }}>
          <legend style={{ padding: '0 6px', fontWeight: 750 }}>Повторение на задачата</legend>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="view-switch" aria-label="Повторение на задачата">
              <button type="button" className={!recurring ? 'active' : ''} onClick={() => setRecurring(false)} aria-pressed={!recurring}>Не</button>
              <button type="button" className={recurring ? 'active' : ''} onClick={() => setRecurring(true)} aria-pressed={recurring}>Да</button>
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
                <label>Ден от седмицата
                  <select value={recurrenceWeekday} onChange={(event) => setRecurrenceWeekday(Number(event.target.value))}>
                    {bulgarianWeekdays.map((weekday, index) => <option key={weekday} value={index + 1}>{weekday}</option>)}
                  </select>
                </label>
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
                  {[1, 2, 3, 4].map((days) => <option key={days} value={days}>{recurrenceLeadLabel(days)} преди крайния срок</option>)}
                </select>
              </label>
              <div style={{ alignSelf: 'end', minHeight: 42, display: 'flex', alignItems: 'center', padding: '0 12px', color: '#4e6590', background: '#eef4ff', border: '1px solid #d6e3f6', borderRadius: 10, fontSize: 12 }}>
                Първата задача се създава веднага. Всеки следващ екземпляр ще се появява {recurrenceLeadLabel(recurrenceLeadDays)} преди собствения си краен срок.
              </div>
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
          <legend>{personal ? 'Изпълнител' : <>Изпълнители <small>(изберете 1–3)</small></>}</legend>
          <div className="people-picker">
            {personal ? (
              <div className="personal-assignee">
                <span className="avatar small">{initials(profile.display_name)}</span>
                <div><strong>{profile.display_name}</strong><small>Задачата ще бъде възложена на вас</small></div>
              </div>
            ) : people.map((person) => (
              <label key={person.id} className={selected.includes(person.id) ? 'selected' : ''}>
                <input
                  type="checkbox"
                  checked={selected.includes(person.id)}
                  onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))}
                />
                <span className="avatar small">{initials(person.display_name)}</span>{person.display_name}
              </label>
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
  const [editing, setEditing] = useState(false)
  const [editDescription, setEditDescription] = useState('')
  const [editDueAt, setEditDueAt] = useState('')
  const [editPriority, setEditPriority] = useState<Priority>('normal')
  const [editMaterials, setEditMaterials] = useState('')
  const [editApprovalRequired, setEditApprovalRequired] = useState(false)
  const [editFiles, setEditFiles] = useState<File[]>([])
  const [reminder, setReminder] = useState<TaskReminder | null>(null)
  const [editReminderEnabled, setEditReminderEnabled] = useState(false)
  const [editRemindAt, setEditRemindAt] = useState('')

  const byId = useMemo(() => new Map(profiles.map((person) => [person.id, person])), [profiles])
  const isCreator = Boolean(task && currentUser && task.created_by === currentUser.id)
  const isAssignee = Boolean(task && currentUser && task.assignees.some((person) => person.id === currentUser.id))
  const canParticipate = Boolean(task && currentUser && (currentUser.role === 'manager' || isAssignee))
  const canAccept = Boolean(task && task.status === 'new' && isAssignee)
  const canWork = Boolean(canParticipate && task && task.status !== 'new' && task.status !== 'completed')
  const canManageFiles = Boolean(task && (canWork || isCreator))

  useEffect(() => {
    if (!task) return
    setEditDescription(task.description)
    setEditDueAt(`${bulgarianDateKey(task.due_at)}T${formatBulgarianTime(task.due_at)}`)
    setEditPriority(task.priority)
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
    if (recurrenceResult.data?.lead_days) setRecurrenceLeadDays(Number(recurrenceResult.data.lead_days))
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
    const { error } = await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', task.id).eq('status', 'new')
    setBusy(false)
    if (error) return onResult({ tone: 'error', message: error.message })
    await onChanged()
    await loadDetail()
    onResult({ tone: 'success', message: 'Задачата е приета и вече е „В процес“.' })
  }

  const changeStatus = async (status: TaskStatus) => {
    if (status === 'new' || status === 'completed') return
    const { error } = await supabase.from('tasks').update({ status }).eq('id', task.id)
    if (error) return onResult({ tone: 'error', message: error.message })
    await onChanged()
    await loadDetail()
    onResult({ tone: 'success', message: `Статусът е променен на „${statusLabels[status]}“.` })
  }

  const finishTask = async () => {
    if (!canWork || busy) return
    const approvedForCompletion = !task.approval_required || approvals.some((approval) => approval.status === 'approved')
    if (!approvedForCompletion) {
      onResult({ tone: 'error', message: 'Задачата изисква одобрение преди да бъде отбелязана като завършена.' })
      return
    }
    if (!window.confirm('Сигурни ли сте, че искате да отбележите задачата като завършена? След потвърждението тя ще бъде преместена в „Завършени“.')) return
    setBusy(true)
    const { error } = await supabase.from('tasks').update({ status: 'completed' }).eq('id', task.id).neq('status', 'completed')
    setBusy(false)
    if (error) return onResult({ tone: 'error', message: error.message })
    await Promise.all([onChanged(), loadDetail()])
    onResult({ tone: 'success', message: 'Задачата е отбелязана като завършена.' })
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
    if (editReminderEnabled) {
      const reminderError = validateTaskReminder(editRemindAt, editDueAt)
      if (reminderError) {
        onResult({ tone: 'error', message: reminderError })
        return
      }
    }
    setBusy(true)
    const { error } = await supabase.from('tasks').update({
      description: editDescription.trim(),
      due_at: new Date(editDueAt).toISOString(),
      priority: editPriority,
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

  const requestApproval = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const { error } = await supabase.from('approvals').insert({
      task_id: task.id,
      requested_by: currentUser.id,
      request_note: approvalNote.trim() || null,
    })
    if (!error) await supabase.from('tasks').update({ status: 'waiting_approval' }).eq('id', task.id)
    setBusy(false)
    if (error) return onResult({ tone: 'error', message: error.message })
    setApprovalNote('')
    await Promise.all([loadDetail(), onChanged()])
    onResult({ tone: 'success', message: 'Заявката за одобрение е изпратена.' })
  }

  const decideApproval = async (approval: Approval, status: Exclude<ApprovalStatus, 'pending'>) => {
    const note = window.prompt('Бележка към решението (по желание):')
    if (note === null) return
    const { error } = await supabase.from('approvals').update({
      status,
      reviewer_id: currentUser.id,
      decision_note: note.trim() || null,
      decided_at: new Date().toISOString(),
    }).eq('id', approval.id)
    if (error) return onResult({ tone: 'error', message: error.message })
    if (status === 'approved') await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', task.id)
    if (status === 'changes_requested') await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', task.id)
    await Promise.all([loadDetail(), onChanged()])
    onResult({ tone: 'success', message: `Решението е записано: ${approvalLabels[status]}.` })
  }

  const taskFiles = files.filter((file) => file.parent_type === 'task')
  const updateFileMap = new Map<string, LogicalFile[]>()
  files.filter((file) => file.progress_update_id).forEach((file) => {
    const current = updateFileMap.get(file.progress_update_id!) || []
    updateFileMap.set(file.progress_update_id!, [...current, file])
  })
  const canStopRecurrence = Boolean(task.recurrence_id && recurrenceActive && (currentUser.role === 'manager' || task.created_by === currentUser.id))
  const approvedForCompletion = !task.approval_required || approvals.some((approval) => approval.status === 'approved')

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
              <div className="task-scheduling-grid">
                <BulgarianDateTimeField value={editDueAt} onChange={setEditDueAt} />
                <label>Приоритет<select value={editPriority} onChange={(event) => setEditPriority(event.target.value as Priority)}>{priorities.map((item) => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select></label>
              </div>
              <label>Необходими материали<textarea rows={2} value={editMaterials} onChange={(event) => setEditMaterials(event.target.value)} placeholder="Линкове, документи или допълнителна информация" /></label>
              <label className="switch-row"><input type="checkbox" checked={editApprovalRequired} onChange={(event) => setEditApprovalRequired(event.target.checked)} /><span>Необходимо е одобрение преди завършване</span></label>
              {task.recurrence_id && recurrenceActive && (
                <fieldset style={{ padding: 14, border: '1px solid #dbe7f6', borderRadius: 14, background: '#ffffff' }}>
                  <legend style={{ padding: '0 6px', fontWeight: 750 }}>↻ Повторение на задачата</legend>
                  <label>Кога да се създава всеки следващ екземпляр
                    <select value={recurrenceLeadDays} onChange={(event) => setRecurrenceLeadDays(Number(event.target.value))}>
                      {[1, 2, 3, 4].map((days) => <option key={days} value={days}>{recurrenceLeadLabel(days)} преди крайния срок</option>)}
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
              <small>Статус</small>
              {task.status === 'completed' ? (
                <strong style={{ color: '#1d4ed8' }}>✓ Завършена</strong>
              ) : task.status === 'new' ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 7 }}>
                  <strong style={{ color: '#2563eb' }}>Отворена · чака приемане</strong>
                  {canAccept && (
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void acceptTask()}>
                      {busy ? 'Приемане…' : '✓ Приеми задачата'}
                    </button>
                  )}
                </div>
              ) : canParticipate ? (
                <select value={task.status} onChange={(event) => void changeStatus(event.target.value as TaskStatus)}>
                  {statuses.filter((status) => status !== 'new' && status !== 'completed').map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
                </select>
              ) : <strong>{statusLabels[task.status]}</strong>}
            </div>
            <div><small>Краен срок</small><strong className={isOverdue(task.due_at, task.status) ? 'overdue-text' : ''}>{formatDateTime(task.due_at)}</strong></div>
            <div><small>Напомняне</small><strong>{reminder ? (reminder.sent_at ? `Изпратено · ${formatDateTime(reminder.sent_at)}` : formatDateTime(reminder.remind_at)) : 'Няма'}</strong></div>
            <div><small>Възложил</small><strong>{task.creator?.display_name || '—'}</strong></div>
            <div><small>Изпълнители</small><strong>{task.assignees.map((person) => person.display_name).join(', ')}</strong></div>
          </div>
          {task.status !== 'completed' && canWork && (
            <div className={`task-completion-panel${approvedForCompletion ? '' : ' waiting-approval'}`}>
              <div>
                <small>Приключване на задачата</small>
                <strong>{approvedForCompletion ? 'Когато работата е готова, отбележете задачата като завършена.' : 'Преди завършване задачата трябва да бъде одобрена.'}</strong>
              </div>
              <button type="button" className="success-button complete-task-button" disabled={busy || !approvedForCompletion} onClick={() => void finishTask()}>✓ Завърши задачата</button>
            </div>
          )}
          {task.status === 'completed' && (
            <div className="task-completed-panel"><span>✓</span><div><small>Задачата е приключена</small><strong>Отбелязана е като завършена и се намира в категория „Завършени“.</strong></div></div>
          )}
          {task.status === 'new' && (
            <div style={{ marginTop: 12, padding: '12px 14px', background: '#eef4ff', border: '1px solid #d6e4f7', borderRadius: 12 }}>
              <small style={{ display: 'block', color: '#7789a8', marginBottom: 3 }}>Работен поток</small>
              <strong style={{ color: '#4b6595' }}>{canAccept ? 'Приемете задачата, за да започнете работа по нея.' : 'Задачата чака да бъде приета от назначен изпълнител.'}</strong>
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
                {updates.length === 0 && <EmptySmall text={task.status === 'new' ? 'Задачата още не е приета. Напредък може да се добавя след приемането.' : 'Все още няма актуализации.'} />}
              </div>
            </section>
          ) : tab === 'files' ? (
            <section className="detail-section">
              {canManageFiles && <label className="upload-drop">＋ Добави файлове към задачата<input type="file" multiple disabled={busy} onChange={(event) => void uploadTaskFiles(event.target.files)} /></label>}
              <div className="file-list">{taskFiles.map((file) => <FileRow key={file.id} file={file} canUpload={canManageFiles} busy={busy} onDownload={downloadVersion} onVersion={uploadVersion} />)}{taskFiles.length === 0 && <EmptySmall text={task.status === 'new' && !isCreator ? 'Файлове могат да се добавят след приемане на задачата.' : 'Няма файлове към задачата.'} />}</div>
            </section>
          ) : tab === 'approvals' ? (
            <section className="detail-section">
              {canWork && task.approval_required && !approvals.some((approval) => approval.status === 'pending') && (
                <form className="approval-request" onSubmit={requestApproval}><input value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder="Бележка към заявката (по желание)" /><button className="primary-button" disabled={busy}>Изпрати за одобрение</button></form>
              )}
              <div className="approval-list">
                {approvals.map((approval) => (
                  <article key={approval.id}>
                    <div><span className={`approval-state ${approval.status}`}>{approvalLabels[approval.status]}</span><time>{formatDateTime(approval.requested_at)}</time></div>
                    <p><strong>{byId.get(approval.requested_by)?.display_name || 'Потребител'}</strong>{approval.request_note ? `: ${approval.request_note}` : ' изпрати задача за одобрение.'}</p>
                    {approval.decision_note && <blockquote>{approval.decision_note}</blockquote>}
                    {approval.status === 'pending' && currentUser.role === 'manager' && <div className="approval-actions"><button onClick={() => void decideApproval(approval, 'changes_requested')}>Върни за промени</button><button className="danger-soft" onClick={() => void decideApproval(approval, 'rejected')}>Отхвърли</button><button className="success-button" onClick={() => void decideApproval(approval, 'approved')}>Одобри</button></div>}
                  </article>
                ))}
                {approvals.length === 0 && <EmptySmall text={task.status === 'new' ? 'Одобрение може да се заяви след приемане на задачата.' : task.approval_required ? 'Все още няма заявка за одобрение.' : 'За тази задача не е изискано одобрение.'} />}
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

function PushButton({ userId, onResult }: { userId: string; onResult: (toast: Toast) => void }) {
  const [supported] = useState(() => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(false)
  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY

  useEffect(() => {
    if (!supported || !vapidKey || Notification.permission !== 'granted') return
    let cancelled = false
    navigator.serviceWorker.register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (!cancelled) setActive(Boolean(subscription))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [supported, vapidKey])

  const enable = async () => {
    if (busy) return
    if (!supported || !vapidKey) {
      onResult({ tone: 'error', message: 'Push известията ще бъдат активирани след финалната VAPID настройка.' })
      return
    }
    if (Notification.permission === 'denied') {
      onResult({ tone: 'error', message: 'Известията са блокирани в настройките на браузъра за този сайт.' })
      return
    }
    setBusy(true)
    try {
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission()
      if (permission !== 'granted') throw new Error('Разрешението за известия не е дадено.')

      await navigator.serviceWorker.register('/sw.js')
      const registration = await navigator.serviceWorker.ready
      const existingSubscription = await registration.pushManager.getSubscription()
      const subscription = existingSubscription || await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        })
      const json = subscription.toJSON()
      if (!json.keys?.p256dh || !json.keys.auth) throw new Error('Браузърът не връща валиден push абонамент.')
      const { error } = await supabase.from('push_subscriptions').upsert({
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent,
      }, { onConflict: 'user_id,endpoint' })
      if (error) throw error
      setActive(true)
      onResult({ tone: 'success', message: existingSubscription ? 'Push известията вече са активни за този браузър.' : 'Push известията са активирани за този браузър.' })
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'Service worker-ът не успя да се активира. Обновете страницата и опитайте отново.'
        : errorText(error)
      onResult({ tone: 'error', message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className={`notification-button${active ? ' active' : ''}`}
      onClick={() => void enable()}
      disabled={busy}
      title={active ? 'Push известията са активни' : 'Активирай push известия'}
    >
      {active ? '●' : '♢'}<span>{busy ? 'Активиране…' : active ? 'Известия активни' : 'Известия'}</span>
    </button>
  )
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)))
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
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
