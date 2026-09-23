import { useCallback, useEffect, useMemo, useState, type CSSProperties, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { supabase } from './lib/supabase'
import { formatDateTime } from './lib/labels'
import type {
  Checklist,
  ChecklistActivity,
  ChecklistField,
  ChecklistFieldType,
  ChecklistItem,
  ChecklistKind,
  ChecklistValue,
  ChecklistValueData,
  Profile,
} from './types'

type Result = { tone: 'success' | 'error'; message: string }
type DrawerView = 'register' | 'activity' | 'settings'
type Dialog = 'item' | 'checklist' | 'field' | 'field-edit' | null
type SortMode = 'manual' | 'alphabetical' | 'edited'
type DragTarget = { id: string; placement: 'before' | 'after' }

interface ChecklistDrawerProps {
  currentUser: Profile
  profiles: Profile[]
  onClose: () => void
  onResult: (result: Result) => void
}

const kindLabels: Record<ChecklistKind, string> = {
  inventory: 'Наличности',
  deadlines: 'Срокове',
  custom: 'Свободен модел',
}

const fieldTypeLabels: Record<ChecklistFieldType, string> = {
  text: 'Текст',
  number: 'Число',
  date: 'Дата',
  boolean: 'Да / Не',
  select: 'Избор',
}

const actionLabels = { insert: 'Добавено', update: 'Променено', delete: 'Премахнато' }
const entityLabels: Record<string, string> = {
  checklists: 'чеклист',
  checklist_fields: 'колона',
  checklist_items: 'ред',
  checklist_values: 'стойност',
}

const formatActivityDate = formatDateTime

const isoToBulgarianDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value
}

const parseBulgarianDate = (value: string) => {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim())
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 1900
    || year > 2200
    || candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const normalizeBulgarianDateInput = (value: string) => {
  const sanitized = value.replace(/[/-]/g, '.').replace(/[^\d.]/g, '').slice(0, 10)
  if (sanitized.includes('.')) return sanitized
  const digits = sanitized.slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`
}

const templateFields = (kind: ChecklistKind) => {
  if (kind === 'inventory') {
    return [
      { key: 'quantity', label: 'Налично', field_type: 'number' as const, settings: { role: 'quantity' } },
      { key: 'minimum', label: 'Минимум', field_type: 'number' as const, settings: { role: 'threshold' } },
      { key: 'unit', label: 'Мярка', field_type: 'text' as const, settings: {} },
      { key: 'last_checked', label: 'Последна проверка', field_type: 'date' as const, settings: { role: 'last_checked' } },
      { key: 'supplier', label: 'Доставчик', field_type: 'text' as const, settings: {} },
    ]
  }
  if (kind === 'deadlines') {
    return [
      { key: 'start_date', label: 'Начало', field_type: 'date' as const, settings: {} },
      { key: 'expires_on', label: 'Изтича на', field_type: 'date' as const, settings: { role: 'deadline' } },
      { key: 'renew_by', label: 'Подновяване до', field_type: 'date' as const, settings: { role: 'renewal' } },
      { key: 'status', label: 'Статус', field_type: 'select' as const, settings: {}, options: ['Активен', 'За подновяване', 'Подновен', 'Приключен'] },
      { key: 'note', label: 'Бележка', field_type: 'text' as const, settings: {} },
    ]
  }
  return [
    { key: 'done', label: 'Готово', field_type: 'boolean' as const, settings: {} },
    { key: 'note', label: 'Бележка', field_type: 'text' as const, settings: {} },
  ]
}

function ChecklistDrawer({ currentUser, profiles, onClose, onResult }: ChecklistDrawerProps) {
  const [checklists, setChecklists] = useState<Checklist[]>([])
  const [fields, setFields] = useState<ChecklistField[]>([])
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [values, setValues] = useState<ChecklistValue[]>([])
  const [activity, setActivity] = useState<ChecklistActivity[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<DrawerView>('register')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [savingCell, setSavingCell] = useState<string | null>(null)
  const [deletingFieldId, setDeletingFieldId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<ChecklistField | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>('manual')
  const [ordering, setOrdering] = useState(false)
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null)
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null)

  const loadData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    const [listsResult, fieldsResult, itemsResult, valuesResult, activityResult] = await Promise.all([
      supabase.from('checklists').select('*').eq('is_archived', false).order('created_at'),
      supabase.from('checklist_fields').select('*').order('position'),
      supabase.from('checklist_items').select('*').eq('is_archived', false).order('position'),
      supabase.from('checklist_values').select('*'),
      supabase.from('checklist_activity').select('*').order('created_at', { ascending: false }).limit(120),
    ])

    const error = listsResult.error || fieldsResult.error || itemsResult.error || valuesResult.error || activityResult.error
    if (error) {
      onResult({ tone: 'error', message: `Чеклистите не можаха да се заредят: ${error.message}` })
      setLoading(false)
      return
    }

    const nextLists = (listsResult.data || []) as Checklist[]
    setChecklists(nextLists)
    setFields((fieldsResult.data || []) as ChecklistField[])
    setItems((itemsResult.data || []) as ChecklistItem[])
    setValues((valuesResult.data || []) as ChecklistValue[])
    setActivity((activityResult.data || []) as ChecklistActivity[])
    setSelectedId((current) => current && nextLists.some((list) => list.id === current) ? current : nextLists[0]?.id || null)
    setLoading(false)
  }, [onResult])

  useEffect(() => {
    void loadData()
    const refresh = () => { void loadData(true) }
    const channel = supabase
      .channel('checklist-drawer-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checklists' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checklist_fields' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checklist_items' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checklist_values' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checklist_activity' }, refresh)
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [loadData])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dialog) { setDialog(null); setEditingField(null) }
        else onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [dialog, onClose])

  useEffect(() => {
    setSortMode('manual')
    setDraggedItemId(null)
    setDragTarget(null)
  }, [selectedId])

  const selected = checklists.find((list) => list.id === selectedId) || null
  const selectedFields = fields.filter((field) => field.checklist_id === selectedId)
  const selectedItems = items.filter((item) => item.checklist_id === selectedId)
  const selectedActivity = activity.filter((entry) => entry.checklist_id === selectedId)
  const valueMap = useMemo(() => new Map(values.map((value) => [`${value.item_id}:${value.field_id}`, value.value])), [values])
  const profileMap = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles])
  const itemLastEditedMap = useMemo(() => {
    const next = new Map<string, number>()
    items.forEach((item) => next.set(item.id, Date.parse(item.created_at) || 0))
    values.forEach((value) => {
      const timestamp = Date.parse(value.updated_at) || 0
      if (timestamp > (next.get(value.item_id) || 0)) next.set(value.item_id, timestamp)
    })
    return next
  }, [items, values])

  const displayedItems = useMemo(() => {
    if (sortMode === 'manual') return selectedItems
    const next = [...selectedItems]
    if (sortMode === 'alphabetical') {
      next.sort((a, b) => a.title.localeCompare(b.title, 'bg', { sensitivity: 'base', numeric: true }) || a.position - b.position)
    } else {
      next.sort((a, b) => (itemLastEditedMap.get(b.id) || 0) - (itemLastEditedMap.get(a.id) || 0) || a.position - b.position)
    }
    return next
  }, [itemLastEditedMap, selectedItems, sortMode])

  const itemHealth = useCallback((item: ChecklistItem) => {
    const listFields = fields.filter((field) => field.checklist_id === item.checklist_id)
    const getRoleValue = (role: string) => {
      const field = listFields.find((candidate) => candidate.settings?.role === role)
      return field ? valueMap.get(`${item.id}:${field.id}`) : undefined
    }

    const quantity = getRoleValue('quantity')
    const threshold = getRoleValue('threshold')
    if (typeof quantity === 'number' && typeof threshold === 'number' && quantity <= threshold) {
      return { tone: quantity <= 0 ? 'danger' : 'warning', label: quantity <= 0 ? 'Изчерпано' : 'За поръчка' }
    }

    const deadline = getRoleValue('renewal') || getRoleValue('deadline')
    if (typeof deadline === 'string' && deadline) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const days = Math.ceil((new Date(`${deadline}T00:00:00`).getTime() - today.getTime()) / 86400000)
      if (days < 0) return { tone: 'danger', label: 'Изтекъл срок' }
      if (days <= 30) return { tone: 'warning', label: days === 0 ? 'Днес' : `${days} дни` }
    }

    const lastCheckedField = listFields.find((field) => field.key === 'last_checked' || field.settings?.role === 'last_checked')
    const lastChecked = lastCheckedField ? valueMap.get(`${item.id}:${lastCheckedField.id}`) : undefined
    if (typeof lastChecked === 'string') {
      const checkedMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastChecked)
      if (checkedMatch) {
        const sofiaParts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Sofia',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(new Date())
        const part = (type: Intl.DateTimeFormatPartTypes) => Number(sofiaParts.find((entry) => entry.type === type)?.value || 0)
        const todayUtc = Date.UTC(part('year'), part('month') - 1, part('day'))
        const checkedUtc = Date.UTC(Number(checkedMatch[1]), Number(checkedMatch[2]) - 1, Number(checkedMatch[3]))
        const calendarDaysSinceCheck = Math.floor((todayUtc - checkedUtc) / 86400000)
        if (calendarDaysSinceCheck > 7) return { tone: 'warning', label: 'Неактуално' }
      }
    }

    return { tone: 'ok', label: 'Актуално' }
  }, [fields, valueMap])

  const warningCount = selectedItems.filter((item) => itemHealth(item).tone !== 'ok').length

  const saveValue = async (item: ChecklistItem, field: ChecklistField, value: ChecklistValueData | '') => {
    const cellKey = `${item.id}:${field.id}`
    setSavingCell(cellKey)
    const existing = valueMap.has(cellKey)
    const result = value === ''
      ? existing
        ? await supabase.from('checklist_values').delete().eq('item_id', item.id).eq('field_id', field.id)
        : { error: null }
      : await supabase.from('checklist_values').upsert({
          checklist_id: item.checklist_id,
          item_id: item.id,
          field_id: field.id,
          value,
          updated_by: currentUser.id,
        }, { onConflict: 'item_id,field_id' })

    if (result.error) onResult({ tone: 'error', message: `Промяната не е записана: ${result.error.message}` })
    else await loadData(true)
    setSavingCell(null)
  }

  const reorderItem = async (sourceId: string, targetId: string, placement: 'before' | 'after') => {
    if (ordering || sortMode !== 'manual' || sourceId === targetId) return
    const sourceIndex = selectedItems.findIndex((item) => item.id === sourceId)
    if (sourceIndex < 0) return

    const next = [...selectedItems]
    const [moved] = next.splice(sourceIndex, 1)
    const targetIndex = next.findIndex((item) => item.id === targetId)
    if (!moved || targetIndex < 0) return
    const insertIndex = targetIndex + (placement === 'after' ? 1 : 0)
    next.splice(insertIndex, 0, moved)

    const positions = new Map(next.map((item, index) => [item.id, index]))
    const changed = next.filter((item, index) => item.position !== index)
    if (changed.length === 0) return

    setOrdering(true)
    setItems((current) => current.map((item) => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item))
    const results = await Promise.all(changed.map((item) => supabase.from('checklist_items').update({ position: positions.get(item.id)! }).eq('id', item.id)))
    const error = results.find((result) => result.error)?.error
    setOrdering(false)
    setDraggedItemId(null)
    setDragTarget(null)
    if (error) {
      onResult({ tone: 'error', message: `Ръчната подредба не беше записана: ${error.message}` })
    }
    await loadData(true)
  }

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, itemId: string) => {
    if (sortMode !== 'manual' || ordering) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', itemId)
    setDraggedItemId(itemId)
  }

  const handleDragOver = (event: DragEvent<HTMLTableRowElement>, itemId: string) => {
    if (sortMode !== 'manual' || ordering || !draggedItemId || draggedItemId === itemId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDragTarget((current) => current?.id === itemId && current.placement === placement ? current : { id: itemId, placement })
  }

  const handleDrop = (event: DragEvent<HTMLTableRowElement>, targetId: string) => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('text/plain') || draggedItemId
    const placement = dragTarget?.id === targetId ? dragTarget.placement : 'before'
    if (sourceId) void reorderItem(sourceId, targetId, placement)
  }

  const archiveItem = async (item: ChecklistItem) => {
    if (!window.confirm(`Да премахна ли реда „${item.title}“? Данните и историята му ще останат запазени.`)) return
    const { error } = await supabase.from('checklist_items').update({ is_archived: true }).eq('id', item.id)
    if (error) onResult({ tone: 'error', message: error.message })
    else {
      onResult({ tone: 'success', message: 'Редът е премахнат от активния чеклист. Историята е запазена.' })
      await loadData(true)
    }
  }

  const archiveChecklist = async () => {
    if (!selected) return
    if (!window.confirm(`Да премахна ли чеклиста „${selected.name}“? Всички негови записи и история ще останат запазени.`)) return
    setBusy(true)
    const { error } = await supabase.from('checklists').update({ is_archived: true }).eq('id', selected.id)
    setBusy(false)
    if (error) onResult({ tone: 'error', message: error.message })
    else {
      setView('register')
      onResult({ tone: 'success', message: 'Чеклистът е премахнат от активния изглед. Историята е запазена.' })
      await loadData(true)
    }
  }

  const createItem = async (title: string, notes: string) => {
    if (!selected) return
    setBusy(true)
    const { error } = await supabase.from('checklist_items').insert({
      checklist_id: selected.id,
      title: title.trim(),
      notes: notes.trim() || null,
      position: selectedItems.length,
      created_by: currentUser.id,
    })
    setBusy(false)
    if (error) return onResult({ tone: 'error', message: error.message })
    setDialog(null)
    onResult({ tone: 'success', message: 'Новият ред е добавен.' })
    await loadData(true)
  }

  const createChecklist = async (data: { name: string; description: string; kind: ChecklistKind; icon: string; color: string }) => {
    setBusy(true)
    const { data: created, error } = await supabase.from('checklists').insert({
      name: data.name.trim(),
      description: data.description.trim() || null,
      kind: data.kind,
      icon: data.icon.trim() || '✓',
      color: data.color,
      created_by: currentUser.id,
    }).select('*').single()

    if (error || !created) {
      setBusy(false)
      return onResult({ tone: 'error', message: error?.message || 'Чеклистът не беше създаден.' })
    }

    const presets = templateFields(data.kind)
    const { error: fieldsError } = await supabase.from('checklist_fields').insert(presets.map((field, index) => ({
      checklist_id: created.id,
      key: field.key,
      label: field.label,
      field_type: field.field_type,
      is_required: false,
      unit: null,
      options: 'options' in field ? field.options : [],
      settings: field.settings,
      position: index,
      created_by: currentUser.id,
    })))
    setBusy(false)
    if (fieldsError) return onResult({ tone: 'error', message: `Чеклистът е създаден, но колоните не са добавени: ${fieldsError.message}` })
    setSelectedId(created.id)
    setView('register')
    setDialog(null)
    onResult({ tone: 'success', message: 'Новият чеклист е готов.' })
    await loadData(true)
  }

  const createField = async (data: { label: string; type: ChecklistFieldType; required: boolean; unit: string; options: string }) => {
    if (!selected) return
    const parsedOptions = data.type === 'select'
      ? data.options.split(',').map((option) => option.trim()).filter(Boolean)
      : []
    if (data.type === 'select' && parsedOptions.length < 2) {
      onResult({ tone: 'error', message: 'Добавете поне две възможности за избор.' })
      return
    }
    setBusy(true)
    const { error } = await supabase.from('checklist_fields').insert({
      checklist_id: selected.id,
      key: `field_${Date.now().toString(36)}`,
      label: data.label.trim(),
      field_type: data.type,
      is_required: data.required,
      unit: data.unit.trim() || null,
      options: parsedOptions,
      settings: {},
      position: selectedFields.length,
      created_by: currentUser.id,
    })
    setBusy(false)
    if (error) return onResult({ tone: 'error', message: error.message })
    setDialog(null)
    onResult({ tone: 'success', message: 'Новата колона е добавена.' })
    await loadData(true)
  }

  const updateField = async (field: ChecklistField, data: { label: string; type: ChecklistFieldType; required: boolean; unit: string; options: string }) => {
    const parsedOptions = data.type === 'select'
      ? data.options.split(',').map((option) => option.trim()).filter(Boolean)
      : []
    if (data.type === 'select' && parsedOptions.length < 2) {
      onResult({ tone: 'error', message: 'Добавете поне две възможности за избор.' })
      return
    }

    const fieldValues = values.filter((value) => value.field_id === field.id && value.value !== null && value.value !== '')
    if (data.type !== field.field_type && fieldValues.length > 0) {
      onResult({ tone: 'error', message: 'Типът на тази колона не може да се сменя, докато има попълнени стойности. Името, мерната единица, опциите и задължителността могат да се редактират свободно.' })
      return
    }

    if (data.type === 'select') {
      const usedOptions = [...new Set(fieldValues.map((entry) => typeof entry.value === 'string' ? entry.value : '').filter(Boolean))]
      const removedUsedOptions = usedOptions.filter((option) => !parsedOptions.includes(option))
      if (removedUsedOptions.length > 0) {
        onResult({ tone: 'error', message: `Не може да премахнете използвана опция: ${removedUsedOptions.join(', ')}.` })
        return
      }
    }

    setBusy(true)
    const { error } = await supabase.from('checklist_fields').update({
      label: data.label.trim(),
      field_type: data.type,
      is_required: data.required,
      unit: data.unit.trim() || null,
      options: parsedOptions,
    }).eq('id', field.id)
    setBusy(false)

    if (error) return onResult({ tone: 'error', message: `Колоната не беше редактирана: ${error.message}` })
    setDialog(null)
    setEditingField(null)
    onResult({ tone: 'success', message: `Колоната „${data.label.trim()}“ е обновена.` })
    await loadData(true)
  }

  const deleteField = async (field: ChecklistField) => {
    if (!window.confirm(`Да премахна ли колоната „${field.label}“? Всички попълнени стойности в нея ще бъдат изтрити, но промяната ще остане в историята.`)) return
    setDeletingFieldId(field.id)
    const { error } = await supabase.from('checklist_fields').delete().eq('id', field.id)
    setDeletingFieldId(null)
    if (error) onResult({ tone: 'error', message: `Колоната не беше премахната: ${error.message}` })
    else {
      onResult({ tone: 'success', message: `Колоната „${field.label}“ е премахната.` })
      await loadData(true)
    }
  }

  const sortButtonStyle = (active: boolean): CSSProperties => ({
    minHeight: 34,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '0 11px',
    color: active ? '#fff' : '#34756f',
    background: active ? 'linear-gradient(135deg, #159889, #087268)' : '#fff',
    border: active ? '1px solid #0e7d72' : '1px solid #c8ded9',
    borderRadius: 10,
    boxShadow: active ? '0 7px 18px rgba(12,127,113,.15)' : 'none',
    fontSize: 9,
    fontWeight: 750,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  })

  return (
    <div className="checklist-backdrop" onMouseDown={onClose} role="presentation">
      <aside className="checklist-drawer" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" aria-label="Чеклисти">
        <header className="checklist-drawer-header">
          <div className="checklist-brand">
            <span className="checklist-brand-mark">▦</span>
            <div><strong>Чеклисти</strong><small>Живи регистри и контролни списъци</small></div>
          </div>
          <div className="checklist-header-status"><i /> Всичко се пази автоматично</div>
          <button className="checklist-close" onClick={onClose} aria-label="Затвори">×</button>
        </header>

        <div className="checklist-drawer-layout">
          <nav className="checklist-sidebar">
            <div className="checklist-sidebar-intro">
              <span>Вашите пространства</span>
              <p>Един гъвкав модел за наличности, срокове и всеки бъдещ процес.</p>
            </div>
            <div className="checklist-nav-list">
              {checklists.map((list) => {
                const listItems = items.filter((item) => item.checklist_id === list.id)
                const alerts = listItems.filter((item) => itemHealth(item).tone !== 'ok').length
                return (
                  <button
                    key={list.id}
                    className={`checklist-nav-card${selectedId === list.id ? ' active' : ''}`}
                    onClick={() => { setSelectedId(list.id); setView('register') }}
                    style={{ '--list-color': list.color } as CSSProperties}
                  >
                    <span className="checklist-nav-icon">{list.icon}</span>
                    <span><strong>{list.name}</strong><small>{listItems.length} записа · {kindLabels[list.kind]}</small></span>
                    {alerts > 0 && <b>{alerts}</b>}
                  </button>
                )
              })}
            </div>
            <button className="checklist-new-space" onClick={() => setDialog('checklist')}><span>＋</span> Нов чеклист</button>
            <div className="checklist-sidebar-foot">
              <span>∞</span><p><strong>Без фиксиран формат</strong>Добавяйте текст, числа, дати, отметки и избори.</p>
            </div>
          </nav>

          <section className="checklist-workspace">
            {loading ? (
              <div className="checklist-loading"><span /><p>Подреждаме чеклистите…</p></div>
            ) : !selected ? (
              <div className="checklist-empty"><span>▦</span><h2>Все още няма чеклисти</h2><p>Създайте първия гъвкав регистър за екипа.</p><button onClick={() => setDialog('checklist')}>＋ Нов чеклист</button></div>
            ) : (
              <>
                <div className="checklist-workspace-head" style={{ '--list-color': selected.color } as CSSProperties}>
                  <div className="checklist-title-mark">{selected.icon}</div>
                  <div className="checklist-title-copy">
                    <span>{kindLabels[selected.kind]}</span>
                    <h2>{selected.name}</h2>
                    <p>{selected.description || 'Гъвкав екипен чеклист.'}</p>
                  </div>
                  <div className="checklist-head-actions">
                    <button className="checklist-new-list-action" onClick={() => setDialog('checklist')}><span>＋</span> Нов чеклист</button>
                    <button className="checklist-add-row" onClick={() => setDialog('item')}><span>＋</span> Добави запис</button>
                    <button className="checklist-delete-list" disabled={busy} onClick={() => void archiveChecklist()} title="Премахни чеклиста"><span>⌫</span><small>Премахни</small></button>
                  </div>
                </div>

                <div className="checklist-metrics">
                  <article><span className="metric-symbol rows">▤</span><div><strong>{selectedItems.length}</strong><small>Записа</small></div></article>
                  <article><span className={`metric-symbol ${warningCount ? 'alert' : 'clear'}`}>{warningCount ? '!' : '✓'}</span><div><strong>{warningCount}</strong><small>Изискват внимание</small></div></article>
                  <article><span className="metric-symbol sync">↻</span><div><strong>Live</strong><small>Екипна синхронизация</small></div></article>
                </div>

                <div className="checklist-tabs">
                  <button className={view === 'register' ? 'active' : ''} onClick={() => setView('register')}>Регистър</button>
                  <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>История <span>{selectedActivity.length}</span></button>
                  <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>Структура</button>
                </div>

                {view === 'register' && (
                  selectedItems.length === 0 ? (
                    <div className="checklist-empty compact"><span>＋</span><h3>Добавете първия запис</h3><p>Например консуматив, човек, договор или стъпка от процес.</p><button onClick={() => setDialog('item')}>Нов запис</button></div>
                  ) : (
                    <>
                      <div style={{ margin: '14px 30px -4px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7 }}>
                        <strong style={{ marginRight: 3, color: '#667f84', fontSize: 9 }}>Подреждане:</strong>
                        <button type="button" style={sortButtonStyle(sortMode === 'alphabetical')} onClick={() => setSortMode('alphabetical')} title="Подреди по име от А до Я">А–Я Азбучно</button>
                        <button type="button" style={sortButtonStyle(sortMode === 'edited')} onClick={() => setSortMode('edited')} title="Покажи най-скоро редактираните записи първи">◷ Последна редакция</button>
                        <button type="button" style={sortButtonStyle(sortMode === 'manual')} onClick={() => setSortMode('manual')} title="Използвай запазения ръчен ред">↕ Ръчно</button>
                        <span style={{ marginLeft: 'auto', color: ordering ? '#167c72' : '#849599', fontSize: 8, fontWeight: 650 }}>
                          {ordering ? 'Записване на реда…' : sortMode === 'manual' ? 'Хванете ↕ и преместете записа.' : 'Сортирането не променя запазения ръчен ред.'}
                        </span>
                      </div>
                      <div className="checklist-table-scroll">
                        <table className="checklist-table">
                          <thead><tr><th className="checklist-main-column">Запис</th>{selectedFields.map((field) => <th key={field.id}>{field.label}{field.unit && <small>{field.unit}</small>}</th>)}<th className="checklist-health-column">Състояние</th><th /></tr></thead>
                          <tbody>{displayedItems.map((item) => {
                            const health = itemHealth(item)
                            const isDropTarget = dragTarget?.id === item.id
                            return (
                              <tr
                                key={item.id}
                                onDragOver={(event) => handleDragOver(event, item.id)}
                                onDrop={(event) => handleDrop(event, item.id)}
                                style={isDropTarget ? {
                                  boxShadow: dragTarget.placement === 'before' ? 'inset 0 3px 0 #1a9b8c' : 'inset 0 -3px 0 #1a9b8c',
                                  background: '#f5fbf9',
                                } : undefined}
                              >
                                <td className="checklist-item-title" style={{ gridTemplateColumns: '28px 4px minmax(0,1fr)', gap: 8 }}>
                                  <button
                                    type="button"
                                    draggable={sortMode === 'manual' && !ordering}
                                    disabled={sortMode !== 'manual' || ordering}
                                    onDragStart={(event) => handleDragStart(event, item.id)}
                                    onDragEnd={() => { setDraggedItemId(null); setDragTarget(null) }}
                                    title={sortMode === 'manual' ? 'Хвани и премести записа' : 'Избери „Ръчно“, за да пренареждаш'}
                                    aria-label={`Премести ${item.title}`}
                                    style={{
                                      width: 26,
                                      height: 32,
                                      display: 'grid',
                                      placeItems: 'center',
                                      padding: 0,
                                      color: sortMode === 'manual' ? '#56827d' : '#b3c0c1',
                                      background: sortMode === 'manual' ? '#f0f7f5' : 'transparent',
                                      border: sortMode === 'manual' ? '1px solid #d6e7e3' : '1px solid transparent',
                                      borderRadius: 8,
                                      fontSize: 15,
                                      lineHeight: 1,
                                      cursor: sortMode === 'manual' ? 'grab' : 'default',
                                    }}
                                  >↕</button>
                                  <span style={{ background: selected.color }} />
                                  <div><strong>{item.title}</strong>{item.notes && <small>{item.notes}</small>}</div>
                                </td>
                                {selectedFields.map((field) => (
                                  <td key={field.id}>
                                    <ValueEditor
                                      field={field}
                                      value={valueMap.get(`${item.id}:${field.id}`)}
                                      saving={savingCell === `${item.id}:${field.id}`}
                                      onSave={(value) => void saveValue(item, field, value)}
                                    />
                                  </td>
                                ))}
                                <td><span className={`checklist-health ${health.tone}`}><i />{health.label}</span></td>
                                <td><button className="checklist-row-delete" onClick={() => void archiveItem(item)} title="Премахни реда"><span>⌫</span> Премахни</button></td>
                              </tr>
                            )
                          })}</tbody>
                        </table>
                      </div>
                    </>
                  )
                )}

                {view === 'activity' && (
                  <div className="checklist-activity-list">
                    {selectedActivity.length === 0 ? <div className="checklist-empty compact"><span>◷</span><h3>Историята е празна</h3><p>Следващите промени ще се появят тук.</p></div> : selectedActivity.map((entry) => (
                      <article key={entry.id}>
                        <span className={`activity-symbol ${entry.action}`}>{entry.action === 'insert' ? '+' : entry.action === 'delete' ? '−' : '↻'}</span>
                        <div><strong>{actionLabels[entry.action]}: {entityLabels[entry.entity_type] || entry.entity_type}</strong><p>{profileMap.get(entry.actor_id || '')?.display_name || 'Системна промяна'}</p></div>
                        <time>{formatActivityDate(entry.created_at)}</time>
                      </article>
                    ))}
                  </div>
                )}

                {view === 'settings' && (
                  <div className="checklist-settings">
                    <div className="checklist-settings-head"><div><span>Модел на данните</span><h3>Колони в чеклиста</h3><p>Тези полета определят каква информация се пази за всеки ред.</p></div><button onClick={() => setDialog('field')}>＋ Добави колона</button></div>
                    <div className="checklist-field-list">
                      {selectedFields.map((field, index) => (
                        <article key={field.id}>
                          <span className="field-order">{String(index + 1).padStart(2, '0')}</span>
                          <div><strong>{field.label}</strong><small>{fieldTypeLabels[field.field_type]}{field.unit ? ` · ${field.unit}` : ''}</small></div>
                          {field.is_required && <b>Задължително</b>}
                          <code>{field.key}</code>
                          <button
                            type="button"
                            onClick={() => { setEditingField(field); setDialog('field-edit') }}
                            title={`Редактирай колоната ${field.label}`}
                            style={{
                              minHeight: 34,
                              padding: '0 11px',
                              borderRadius: 9,
                              border: '1px solid #b9d7d2',
                              background: '#f4fbf9',
                              color: '#167c72',
                              fontSize: 9,
                              fontWeight: 750,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            ✎ Редактирай
                          </button>
                          <button className="checklist-field-delete" disabled={deletingFieldId === field.id} onClick={() => void deleteField(field)} title={`Премахни колоната ${field.label}`}>
                            <span>⌫</span>{deletingFieldId === field.id ? 'Премахване…' : 'Премахни'}
                          </button>
                        </article>
                      ))}
                    </div>
                    <div className="checklist-model-note"><span>✦</span><p><strong>Моделът е разширяем</strong>Новите колони се появяват веднага за всички записи, без да се губят съществуващи данни.</p></div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        {dialog === 'item' && selected && <ItemDialog busy={busy} listName={selected.name} onClose={() => setDialog(null)} onSubmit={createItem} />}
        {dialog === 'checklist' && <ChecklistDialog busy={busy} onClose={() => setDialog(null)} onSubmit={createChecklist} />}
        {dialog === 'field' && selected && <FieldDialog busy={busy} onClose={() => setDialog(null)} onSubmit={createField} />}
        {dialog === 'field-edit' && editingField && (
          <FieldDialog
            busy={busy}
            field={editingField}
            hasValues={values.some((value) => value.field_id === editingField.id && value.value !== null && value.value !== '')}
            onClose={() => { setDialog(null); setEditingField(null) }}
            onSubmit={(data) => void updateField(editingField, data)}
          />
        )}
      </aside>
    </div>
  )
}

function ValueEditor({ field, value, saving, onSave }: { field: ChecklistField; value?: ChecklistValueData; saving: boolean; onSave: (value: ChecklistValueData | '') => void }) {
  const initialDraft = value === undefined ? '' : field.field_type === 'date' ? isoToBulgarianDate(String(value)) : String(value)
  const [draft, setDraft] = useState(initialDraft)
  const [invalidDate, setInvalidDate] = useState(false)
  useEffect(() => {
    setDraft(value === undefined ? '' : field.field_type === 'date' ? isoToBulgarianDate(String(value)) : String(value))
    setInvalidDate(false)
  }, [field.field_type, value])

  if (field.field_type === 'boolean') {
    const checked = value === true
    return <button className={`checklist-toggle${checked ? ' checked' : ''}${saving ? ' saving' : ''}`} onClick={() => onSave(!checked)} aria-pressed={checked}><i>{checked ? '✓' : ''}</i><span>{checked ? 'Да' : 'Не'}</span></button>
  }
  if (field.field_type === 'select') {
    return <div className={`checklist-cell-control select${saving ? ' saving' : ''}`}><select value={draft} onChange={(event) => { setDraft(event.target.value); onSave(event.target.value) }}><option value="">0</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></div>
  }

  if (field.field_type === 'date') {
    const commitDate = () => {
      if (!draft.trim()) {
        setInvalidDate(false)
        if (value !== undefined && value !== '') onSave('')
        return
      }
      const parsed = parseBulgarianDate(draft)
      if (!parsed) {
        setInvalidDate(true)
        return
      }
      setInvalidDate(false)
      setDraft(isoToBulgarianDate(parsed))
      if (parsed !== String(value ?? '')) onSave(parsed)
    }
    return (
      <div className={`checklist-cell-control date${invalidDate ? ' invalid' : ''}${saving ? ' saving' : ''}`}>
        <input
          type="text"
          inputMode="numeric"
          maxLength={10}
          value={draft}
          placeholder="ДД.ММ.ГГГГ"
          aria-label={`${field.label}, дата във формат ден, месец, година`}
          aria-invalid={invalidDate}
          title={invalidDate ? 'Въведете валидна дата във формат ДД.ММ.ГГГГ' : 'Български формат: ДД.ММ.ГГГГ'}
          onChange={(event) => {
            setInvalidDate(false)
            setDraft(normalizeBulgarianDateInput(event.target.value))
          }}
          onBlur={commitDate}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
        <small className="date-format-hint">{invalidDate ? 'Невалидна дата' : 'ДД.ММ.ГГГГ'}</small>
      </div>
    )
  }

  const commit = () => {
    if (draft === (value === undefined ? '' : String(value))) return
    if (field.field_type === 'number') onSave(draft === '' ? '' : Number(draft))
    else onSave(draft)
  }
  return <div className={`checklist-cell-control${saving ? ' saving' : ''}`}><input type={field.field_type === 'number' ? 'number' : 'text'} value={draft} placeholder="0" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></div>
}

function DialogShell({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode }) {
  return <div className="checklist-dialog-backdrop" onMouseDown={onClose}><section className="checklist-dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><span>{eyebrow}</span><h3>{title}</h3></div><button onClick={onClose} aria-label="Затвори">×</button></header>{children}</section></div>
}

function ItemDialog({ busy, listName, onClose, onSubmit }: { busy: boolean; listName: string; onClose: () => void; onSubmit: (title: string, notes: string) => void }) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); if (title.trim()) onSubmit(title, notes) }
  return <DialogShell eyebrow={listName} title="Нов запис" onClose={onClose}><form className="checklist-dialog-form" onSubmit={submit}><label>Име на записа<input autoFocus required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Напр. Тонер за принтер" /></label><label>Бележка <small>по желание</small><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Допълнителен контекст…" /></label><footer><button type="button" onClick={onClose}>Отказ</button><button className="primary" disabled={busy || !title.trim()}>{busy ? 'Добавяне…' : 'Добави запис'}</button></footer></form></DialogShell>
}

function ChecklistDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (data: { name: string; description: string; kind: ChecklistKind; icon: string; color: string }) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<ChecklistKind>('custom')
  const [icon, setIcon] = useState('✓')
  const [color, setColor] = useState('#159b8c')
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim()) onSubmit({ name, description, kind, icon, color }) }
  return <DialogShell eyebrow="Гъвкав модел" title="Нов чеклист" onClose={onClose}><form className="checklist-dialog-form" onSubmit={submit}><div className="checklist-dialog-grid"><label className="wide">Име<input autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Напр. Служебни автомобили" /></label><label className="wide">Описание<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Какво ще следите тук?" /></label><label>Начален модел<select value={kind} onChange={(event) => setKind(event.target.value as ChecklistKind)}><option value="custom">Свободен</option><option value="inventory">Наличности</option><option value="deadlines">Срокове</option></select></label><label>Символ<input maxLength={8} value={icon} onChange={(event) => setIcon(event.target.value)} /></label><label>Акцент<input className="color-input" type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label></div><div className="checklist-template-preview"><span>✦</span><p><strong>{kindLabels[kind]}</strong>Ще добавим подходящи начални колони, които после могат да се разширяват.</p></div><footer><button type="button" onClick={onClose}>Отказ</button><button className="primary" disabled={busy || !name.trim()}>{busy ? 'Създаване…' : 'Създай чеклист'}</button></footer></form></DialogShell>
}

function FieldDialog({ busy, field, hasValues = false, onClose, onSubmit }: { busy: boolean; field?: ChecklistField; hasValues?: boolean; onClose: () => void; onSubmit: (data: { label: string; type: ChecklistFieldType; required: boolean; unit: string; options: string }) => void }) {
  const [label, setLabel] = useState(field?.label || '')
  const [type, setType] = useState<ChecklistFieldType>(field?.field_type || 'text')
  const [required, setRequired] = useState(field?.is_required || false)
  const [unit, setUnit] = useState(field?.unit || '')
  const [options, setOptions] = useState(field?.options?.join(', ') || '')
  const isEditing = Boolean(field)
  const submit = (event: FormEvent) => { event.preventDefault(); if (label.trim()) onSubmit({ label, type, required, unit, options }) }
  return <DialogShell eyebrow="Структура" title={isEditing ? `Редакция: ${field?.label}` : 'Нова колона'} onClose={onClose}><form className="checklist-dialog-form" onSubmit={submit}><div className="checklist-dialog-grid"><label className="wide">Име на колоната<input autoFocus required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Напр. Отговорник" /></label><label>Тип<select value={type} disabled={isEditing && hasValues} onChange={(event) => setType(event.target.value as ChecklistFieldType)}>{(Object.keys(fieldTypeLabels) as ChecklistFieldType[]).map((key) => <option key={key} value={key}>{fieldTypeLabels[key]}</option>)}</select>{isEditing && hasValues && <small>Типът е заключен, защото колоната вече съдържа данни.</small>}</label><label>Мерна единица<input maxLength={30} value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="бр., пакета…" /></label>{type === 'select' && <label className="wide">Възможности <small>разделени със запетая</small><input required value={options} onChange={(event) => setOptions(event.target.value)} placeholder="Активен, Изчаква, Приключен" /></label>}</div><label className="checklist-required"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} /><span><strong>Задължително поле</strong><small>Отбелязва колоната като важна за всеки запис.</small></span></label><footer><button type="button" onClick={onClose}>Отказ</button><button className="primary" disabled={busy || !label.trim()}>{busy ? (isEditing ? 'Записване…' : 'Добавяне…') : (isEditing ? 'Запази промените' : 'Добави колона')}</button></footer></form></DialogShell>
}

export default ChecklistDrawer
