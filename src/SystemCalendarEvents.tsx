import { useCallback, useEffect, useMemo, useState } from 'react'
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
  events.filter((event) =>
    event.is_locked
    && key >= event.starts_on
    && key <= event.ends_on
    && isoWeekday(key) === event.weekday
  )

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

export default function SystemCalendarEvents() {
  const [events, setEvents] = useState<SystemCalendarEvent[]>([])
  const [targets, setTargets] = useState<CalendarTarget[]>([])

  const loadEvents = useCallback(async () => {
    const { data, error } = await supabase
      .from('system_calendar_events')
      .select('id,event_key,title,weekday,time_local,starts_on,ends_on,is_locked')
      .eq('is_locked', true)
      .order('starts_on')

    if (!error) setEvents((data || []) as SystemCalendarEvent[])
  }, [])

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) void loadEvents()
    })

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) void loadEvents()
      else setEvents([])
    })

    return () => authListener.subscription.unsubscribe()
  }, [loadEvents])

  useEffect(() => {
    const refreshTargets = () => {
      const next = collectCalendarTargets()
      setTargets((current) => sameTargets(current, next) ? current : next)
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
