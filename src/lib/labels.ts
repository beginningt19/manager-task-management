import type { ApprovalStatus, Priority, TaskStatus } from '../types'

export const statusLabels: Record<TaskStatus, string> = {
  new: 'Отворена',
  in_progress: 'В процес',
  waiting_external: 'Изчаква външна страна',
  waiting_approval: 'Изчаква одобрение',
  completed: 'Завършена',
}

export const priorityLabels: Record<Priority, string> = {
  low: 'Нисък',
  normal: 'Нормален',
  high: 'Висок',
  urgent: 'Спешен',
}

export const approvalLabels: Record<ApprovalStatus, string> = {
  pending: 'Изчаква решение',
  approved: 'Одобрено',
  rejected: 'Отхвърлено',
  changes_requested: 'Върнато за промени',
}

export const statuses = Object.keys(statusLabels) as TaskStatus[]
export const priorities = Object.keys(priorityLabels) as Priority[]

export const BULGARIA_TIME_ZONE = 'Europe/Sofia'

export const formatDateTime = (value: string | Date) =>
  new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: BULGARIA_TIME_ZONE,
  }).format(new Date(value))

export const formatBulgarianTime = (value: string | Date) =>
  new Intl.DateTimeFormat('bg-BG', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: BULGARIA_TIME_ZONE,
  }).format(new Date(value))

export const formatBulgarianDateLong = (value: string | Date) =>
  new Intl.DateTimeFormat('bg-BG', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: BULGARIA_TIME_ZONE,
  }).format(new Date(value))

export const bulgarianDateKey = (value: string | Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: BULGARIA_TIME_ZONE,
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export const isOverdue = (dueAt: string, status: TaskStatus) =>
  status !== 'completed' && new Date(dueAt).getTime() < Date.now()

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
