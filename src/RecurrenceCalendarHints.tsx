import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './lib/supabase'
import './recurrence-calendar-hints.css'

type RecurrenceRow = {
  id: string
  description: string
  frequency: 'daily' | 'weekly' | 'monthly'
  next_due_at: string
  lead_days: number
  weekdays: number[] | null
  month_day: number | null
  is_active: boolean
  calendar_year_ahead: boolean
}

type CalendarTarget = {
  key: string
  target: HTMLElement
}

const DAY_MS = 24 * 60 * 60 * 1000

const dateKeyFromCalendarTitle = (value: string | null) => {
  if (!value) return null
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!match) return null
  return `${match[3]}-${match[2]}-${match[1]}`
}

const sofiaDateKey = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  return year && month && day ? `${year}-${month}-${day}` : null
}

const parseKey = (key: string) => {
  const [year, month, day] = key.split('-').map(Number)
  return { year, month, day }
}

const addDays = (key: string, days: number) => {
  const { year, month, day } = parseKey(key)
  const next = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

const addYears = (key: string, years: number) => {
  const { year, month, day } = parseKey(key)
  const targetYear = year + years
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate()
  return `${targetYear}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

const nextMonthlyKey = (key: string, monthDay: number) => {
  const { year, month } = parseKey(key)
  const nextMonthIndex = month
  const nextYear = year + Math.floor(nextMonthIndex / 12)
  const normalizedMonthIndex = nextMonthIndex % 12
  const lastDay = new Date(Date.UTC(nextYear, normalizedMonthIndex + 1, 0)).getUTCDate()
  const day = Math.min(monthDay, lastDay)
  return `${nextYear}-${String(normalizedMonthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const isoWeekday = (key: string) => {
  const { year, month, day } = parseKey(key)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

const nextWeeklyKey = (key: string, weekdays: number[]) => {
  const selected = [...new Set(weekdays)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b)
  if (!selected.length) return addDays(key, 7)

  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = addDays(key, offset)
    if (selected.includes(isoWeekday(candidate))) return candidate
  }

  return addDays(key, 7)
}

const nextOccurrenceKey = (recurrence: RecurrenceRow, currentKey: string) => {
  if (recurrence.frequency === 'daily') return addDays(currentKey, 1)
  if (recurrence.frequency === 'weekly') return nextWeeklyKey(currentKey, recurrence.weekdays || [])
  if (recurrence.frequency === 'monthly' && recurrence.month_day) return nextMonthlyKey(currentKey, recurrence.month_day)
  return null
}

const leadLabel = (days: number) => days === 0 ? 'в деня на срока' : days === 1 ? '1 ден по-рано' : `${days} дни по-рано`

const collectCalendarTargets = (): CalendarTarget[] => {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.calendar-date-button'))
    .map((button) => {
      const key = dateKeyFromCalendarTitle(button.title)
      const day = button.closest<HTMLElement>('.calendar-day')
      const target = day?.querySelector<HTMLElement>('.calendar-day-tasks') || null
      return key && target ? { key, target } : null
    })
    .filter((item): item is CalendarTarget => Boolean(item))
}

const sameTargets = (left: CalendarTarget[], right: CalendarTarget[]) =>
  left.length === right.length && left.every((item, index) => item.key === right[index]?.key && item.target === right[index]?.target)

const buildOccurrences = (recurrences: RecurrenceRow[], targets: CalendarTarget[]) => {
  const byDay = new Map<string, RecurrenceRow[]>()
  if (targets.length === 0) return byDay

  const keys = targets.map((item) => item.key).sort()
  const minKey = keys[0]
  const maxKey = keys[keys.length - 1]
  const todayKey = sofiaDateKey(new Date().toISOString())
  const horizonKey = todayKey ? addYears(todayKey, 1) : maxKey
  const visibleMaxKey = horizonKey < maxKey ? horizonKey : maxKey

  for (const recurrence of recurrences) {
    let key = sofiaDateKey(recurrence.next_due_at)
    let guard = 0

    while (key && key < minKey && guard < 500) {
      key = nextOccurrenceKey(recurrence, key)
      guard += 1
    }

    while (key && key <= visibleMaxKey && guard < 560) {
      if (key >= minKey) {
        const bucket = byDay.get(key) || []
        bucket.push(recurrence)
        byDay.set(key, bucket)
      }
      key = nextOccurrenceKey(recurrence, key)
      guard += 1
    }
  }

  for (const items of byDay.values()) {
    items.sort((a, b) => a.description.localeCompare(b.description, 'bg-BG'))
  }

  return byDay
}

function RecurrencePreview({ items }: { items: RecurrenceRow[] }) {
  return (
    <div className="calendar-recurrence-preview">
      {items.slice(0, 2).map((item) => (
        <div
          key={item.id}
          className="calendar-recurrence-hint"
          title={`Предстоящо повторение: ${item.description}\nЗадачата ще се генерира ${leadLabel(item.lead_days)}.`}
        >
          ↻ Предстои · {item.description}
        </div>
      ))}
      {items.length > 2 && (
        <div
          className="calendar-recurrence-more"
          title={items.slice(2).map((item) => item.description).join('\n')}
        >
          +{items.length - 2} повторения
        </div>
      )}
    </div>
  )
}

export default function RecurrenceCalendarHints() {
  const [recurrences, setRecurrences] = useState<RecurrenceRow[]>([])
  const [targets, setTargets] = useState<CalendarTarget[]>([])

  const loadRecurrences = useCallback(async () => {
    const { data, error } = await supabase
      .from('task_recurrences')
      .select('id,description,frequency,next_due_at,lead_days,weekdays,month_day,is_active,calendar_year_ahead')
      .eq('is_active', true)
      .eq('calendar_year_ahead', true)
      .order('next_due_at')

    if (!error) setRecurrences((data || []) as RecurrenceRow[])
  }, [])

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) void loadRecurrences()
    })

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) void loadRecurrences()
      else setRecurrences([])
    })

    const channel = supabase
      .channel('calendar-recurrence-hints')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_recurrences' }, () => void loadRecurrences())
      .subscribe()

    return () => {
      authListener.subscription.unsubscribe()
      void supabase.removeChannel(channel)
    }
  }, [loadRecurrences])

  useEffect(() => {
    let frame = 0

    const refreshTargets = () => {
      frame = 0
      const next = collectCalendarTargets()
      setTargets((current) => sameTargets(current, next) ? current : next)
    }

    const scheduleRefresh = () => {
      if (frame) return
      frame = window.requestAnimationFrame(refreshTargets)
    }

    refreshTargets()
    const observer = new MutationObserver(scheduleRefresh)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  const occurrences = useMemo(() => buildOccurrences(recurrences, targets), [recurrences, targets])

  return (
    <>
      {targets.map(({ key, target }) => {
        const items = occurrences.get(key) || []
        return items.length > 0
          ? createPortal(<RecurrencePreview items={items} />, target, `recurrence-${key}`)
          : null
      })}
    </>
  )
}
