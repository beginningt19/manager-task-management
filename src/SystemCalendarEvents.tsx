import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './lib/supabase'
import './system-calendar-events.css'

type SystemCalendarEvent = {
  id: string
  event_key: string
  title: string
  weekday: number
  time_local: string
  starts_on: string
  ends_on: string
  is_locked: boolean
}

type CalendarTarget = {
  key: string
  target: HTMLElement
}

type SystemEventMode = 'once' | 'weekly'

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

const addOneYear = (key: string) => {
  const date = dateFromKey(key)
  const month = date.getMonth()
  const day = date.getDate()
  date.setFullYear(date.getFullYear() + 1)
  if (date.getMonth() !== month) date.setDate(0)
  if (date.getDate() !== day && month !== 1) date.setDate(Math.min(day, date.getDate()))
  return localDateKey(date)
}

const dateKeyFromCalendarTitle = (value: string | null) => {
  if (!value) return null
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!match) return null
  return `${match[3]}-${match[2]}-${match[1]}`
}

const isoWeekday = (key: string) => {
  const [year, month, day] = key.split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

const weekdayLabel = (key: string) =>
  new Intl.DateTimeFormat('bg-BG', { weekday: 'long' }).format(dateFromKey(key))

const formatTime = (value: string) => value.slice(0, 5)

const collectCalendarTargets = (): CalendarTarget[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.calendar-date-button'))
    .map((button) => {
      const key = dateKeyFromCalendarTitle(button.title)
      const day = button.closest<HTMLElement>('.calendar-day')
      const target = day?.querySelector<HTMLElement>('.calendar-day-tasks') || null
      return key && target ? { key, target } : null
    })
    .filter((item): item is CalendarTarget => Boolean(item))

const sameTargets = (left: CalendarTarget[], right: CalendarTarget[]) =>
  left.length === right.length
  && left.every((item, index) => item.key === right[index]?.key && item.target === right[index]?.target)

const eventsForDay = (events: SystemCalendarEvent[], key: string) =>
  events
    .filter((event) =>
      event.is_locked
      && key >= event.starts_on
      && key <= event.ends_on
      && isoWeekday(key) === event.weekday
    )
    .sort((a, b) => a.time_local.localeCompare(b.time_local) || a.title.localeCompare(b.title, 'bg-BG'))

function LockedCalendarEvent({ event }: { event: SystemCalendarEvent }) {
  return (
    <div
      className="calendar-system-event"
      title={`Заключено системно събитие · ${formatTime(event.time_local)} · ${event.title}`}
      aria-label={`${formatTime(event.time_local)} ${event.title}. Заключено системно събитие.`}
    >
      <time>{formatTime(event.time_local)}</time>
      <span>{event.title}</span>
      <b title="Заключено · не може да се редактира или изтрива" aria-hidden="true">🔒</b>
    </div>
  )
}

function CreateSystemEventModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const today = localDateKey()
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<SystemEventMode>('weekly')
  const [startsOn, setStartsOn] = useState(today)
  const [timeLocal, setTimeLocal] = useState('13:00')
  const [endsOn, setEndsOn] = useState(addOneYear(today))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const changeStart = (value: string) => {
    const next = value || today
    setStartsOn(next)
    if (mode === 'weekly') setEndsOn(addOneYear(next))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setError('')

    const { error: createError } = await supabase.rpc('create_locked_system_calendar_event', {
      p_title: title.trim(),
      p_mode: mode,
      p_starts_on: startsOn,
      p_time_local: `${timeLocal}:00`,
      p_ends_on: mode === 'weekly' ? endsOn : null,
    })

    if (createError) {
      setError(createError.message)
      setBusy(false)
      return
    }

    await onCreated()
    setBusy(false)
    onClose()
  }

  return createPortal(
    <div className="system-event-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="system-event-modal" role="dialog" aria-modal="true" aria-label="Ново заключено системно събитие">
        <header>
          <div>
            <small>КАЛЕНДАР · СИСТЕМНО</small>
            <h2>Заключено системно събитие</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Затвори">×</button>
        </header>

        <form onSubmit={submit}>
          <div className="system-event-lock-note">
            <span aria-hidden="true">🔒</span>
            <div>
              <strong>След създаване събитието се заключва.</strong>
              <small>Няма да може да бъде редактирано или изтрито през системата.</small>
            </div>
          </div>

          <label>
            <span>Име на събитието</span>
            <input
              required
              minLength={2}
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Напр. Седмична оперативка"
              autoFocus
            />
          </label>

          <fieldset>
            <legend>Повторение</legend>
            <div className="system-event-mode">
              <button type="button" className={mode === 'once' ? 'active' : ''} onClick={() => setMode('once')}>Еднократно</button>
              <button type="button" className={mode === 'weekly' ? 'active' : ''} onClick={() => {
                setMode('weekly')
                setEndsOn(addOneYear(startsOn))
              }}>Всяка седмица</button>
            </div>
          </fieldset>

          <div className="system-event-grid">
            <label>
              <span>{mode === 'weekly' ? 'Първа дата' : 'Дата'}</span>
              <input type="date" required value={startsOn} onChange={(event) => changeStart(event.target.value)} />
              {mode === 'weekly' && <small>Повтаря се всеки {weekdayLabel(startsOn)}.</small>}
            </label>

            <label>
              <span>Час</span>
              <input type="time" required value={timeLocal} onChange={(event) => setTimeLocal(event.target.value)} />
            </label>

            {mode === 'weekly' && (
              <label>
                <span>Крайна дата</span>
                <input
                  type="date"
                  required
                  min={startsOn}
                  value={endsOn}
                  onChange={(event) => setEndsOn(event.target.value)}
                />
                <small>По подразбиране: една година от първата дата.</small>
              </label>
            )}
          </div>

          {error && <p className="system-event-error">{error}</p>}

          <footer>
            <button type="button" className="system-event-cancel" onClick={onClose} disabled={busy}>Отказ</button>
            <button type="submit" className="system-event-create" disabled={busy || !title.trim()}>
              {busy ? 'Създаване…' : '🔒 Създай и заключи'}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  )
}

export default function SystemCalendarEvents() {
  const [events, setEvents] = useState<SystemCalendarEvent[]>([])
  const [targets, setTargets] = useState<CalendarTarget[]>([])
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [creating, setCreating] = useState(false)

  const loadEvents = useCallback(async () => {
    const { data, error } = await supabase
      .from('system_calendar_events')
      .select('id,event_key,title,weekday,time_local,starts_on,ends_on,is_locked')
      .eq('is_locked', true)
      .order('starts_on')

    if (!error) setEvents((data || []) as SystemCalendarEvent[])
  }, [])

  const loadAccess = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('role,display_role,is_active')
      .eq('id', userId)
      .maybeSingle()

    setCanManage(Boolean(data?.is_active && (data.display_role === 'Управител' || data.role === 'admin')))
  }, [])

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        void loadEvents()
        void loadAccess(data.session.user.id)
      }
    })

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        void loadEvents()
        void loadAccess(session.user.id)
      } else {
        setEvents([])
        setCanManage(false)
      }
    })

    const channel = supabase
      .channel('system-calendar-events')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'system_calendar_events' }, () => void loadEvents())
      .subscribe()

    return () => {
      authListener.subscription.unsubscribe()
      void supabase.removeChannel(channel)
    }
  }, [loadAccess, loadEvents])

  useEffect(() => {
    const refreshTargets = () => {
      const next = collectCalendarTargets()
      setTargets((current) => sameTargets(current, next) ? current : next)
      setToolbarTarget(document.querySelector<HTMLElement>('.calendar-toolbar'))
    }

    refreshTargets()
    const timer = window.setInterval(refreshTargets, 400)
    return () => window.clearInterval(timer)
  }, [])

  const byDay = useMemo(() => {
    const map = new Map<string, SystemCalendarEvent[]>()
    targets.forEach(({ key }) => {
      const matching = eventsForDay(events, key)
      if (matching.length) map.set(key, matching)
    })
    return map
  }, [events, targets])

  return (
    <>
      {canManage && toolbarTarget && createPortal(
        <button
          type="button"
          className="calendar-system-create-button"
          onClick={() => setCreating(true)}
          title="Създай заключено системно събитие"
        >
          <span aria-hidden="true">🔒</span>
          ＋ Системно събитие
        </button>,
        toolbarTarget,
        'system-calendar-create-button',
      )}

      {creating && (
        <CreateSystemEventModal
          onClose={() => setCreating(false)}
          onCreated={loadEvents}
        />
      )}

      {targets.map(({ key, target }) => {
        const items = byDay.get(key) || []
        return items.length
          ? createPortal(
              <div className="calendar-system-events">
                {items.map((event) => <LockedCalendarEvent key={event.id} event={event} />)}
              </div>,
              target,
              `system-calendar-${key}`,
            )
          : null
      })}
    </>
  )
}
