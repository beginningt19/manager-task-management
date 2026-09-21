import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
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
}

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
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

const voiceCommands: ReadonlyArray<readonly [string, string]> = [
  ['точка и запетая', ';'],
  ['въпросителен знак', '?'],
  ['удивителен знак', '!'],
  ['двоеточие', ':'],
  ['запетая', ','],
  ['точка', '.'],
  ['тире', ' - '],
  ['нов ред', '\n'],
]

const formatVoiceText = (value: string) => {
  let next = ` ${value} `
  voiceCommands.forEach(([spoken, replacement]) => {
    next = next.replace(new RegExp(`\\s+${spoken}(?=\\s|$)`, 'giu'), replacement)
  })
  return next
    .replace(/[ \t]+([,.;:?!])/g, '$1')
    .replace(/([,.;:?!])(?=\S)/g, '$1 ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
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

const sortPages = (items: NotebookPage[]) =>
  [...items].sort((a, b) =>
    b.page_date.localeCompare(a.page_date)
    || a.page_number - b.page_number
  )

export default function NotebookDrawer({
  currentUser,
  onClose,
  onResult,
}: {
  currentUser: Profile
  onClose: () => void
  onResult: (toast: Toast) => void
}) {
  const [pages, setPages] = useState<NotebookPage[]>([])
  const [entries, setEntries] = useState<NotebookEntry[]>([])
  const [selectedDate, setSelectedDate] = useState(localDateKey())
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceInterim, setVoiceInterim] = useState('')
  const [voiceMessage, setVoiceMessage] = useState('')
  const [pageTurn, setPageTurn] = useState<'forward' | 'backward'>('forward')
  const [pageTurnNonce, setPageTurnNonce] = useState(0)

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const voiceBaseRef = useRef('')
  const voiceSegmentsRef = useRef<Map<number, string>>(new Map())
  const rolloverDateRef = useRef<string | null>(null)

  const loadData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    const [pagesResult, entriesResult] = await Promise.all([
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
    ])

    const error = pagesResult.error || entriesResult.error
    if (error) {
      onResult({ tone: 'error', message: `Тефтерът не можа да се зареди: ${error.message}` })
      setLoading(false)
      return
    }

    const nextPages = sortPages((pagesResult.data || []) as NotebookPage[])
    setPages(nextPages)
    setEntries((entriesResult.data || []) as NotebookEntry[])

    setSelectedPageId((current) => {
      if (current && nextPages.some((page) => page.id === current)) return current
      const sameDate = nextPages.filter((page) => page.page_date === selectedDate)
      return sameDate[sameDate.length - 1]?.id || null
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
      recognitionRef.current?.abort()
      void supabase.removeChannel(channel)
    }
  }, [currentUser.id, loadData])

  useEffect(() => {
    if (rolloverDateRef.current === selectedDate) return
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
    return pagesForDate[pagesForDate.length - 1] || null
  }, [pagesForDate, selectedPageId])

  const pageEntries = useMemo(
    () => selectedPage
      ? entries.filter((entry) => entry.page_id === selectedPage.id).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
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
    setSelectedPageId(matching[matching.length - 1]?.id || null)
    setEditingId(null)
  }

  const choosePage = (page: NotebookPage) => {
    if (page.id === selectedPage?.id) return
    triggerPageTurn(page.page_number > activePageNumber ? 'forward' : 'backward')
    setSelectedPageId(page.id)
    setEditingId(null)
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
    })
    setBusy(false)

    if (error) {
      onResult({ tone: 'error', message: `Записът не беше добавен: ${error.message}` })
      return
    }

    setDraft('')
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
  }

  const saveEdit = async (entry: NotebookEntry) => {
    const body = editingText.trim()
    if (!body || busy) return

    if (body === entry.body.trim()) {
      setEditingId(null)
      setEditingText('')
      return
    }

    setBusy(true)
    const { error } = await supabase
      .from('notebook_entries')
      .update({ body, edited_at: new Date().toISOString() })
      .eq('id', entry.id)
      .eq('user_id', currentUser.id)
    setBusy(false)

    if (error) {
      onResult({ tone: 'error', message: `Редакцията не беше записана: ${error.message}` })
      return
    }

    setEditingId(null)
    setEditingText('')
    await loadData(true)
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
    recognitionRef.current?.stop()
    setListening(false)
  }

  const startVoice = () => {
    if (listening) {
      stopVoice()
      return
    }

    const Recognition = getSpeechRecognitionConstructor()
    if (!Recognition) {
      setVoiceMessage('Гласовото въвеждане не се поддържа от този браузър. Използвайте Chrome или Edge.')
      return
    }

    const recognition = new Recognition()
    recognition.lang = 'bg-BG'
    recognition.continuous = true
    recognition.interimResults = true
    recognitionRef.current = recognition
    voiceBaseRef.current = draft.trim()
    voiceSegmentsRef.current = new Map()
    setVoiceInterim('')
    setVoiceMessage('')

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
      setDraft(formatVoiceText(combined))
      setVoiceInterim(formatVoiceText(interim))
    }

    recognition.onerror = (event) => {
      const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Разрешете достъпа до микрофона, за да диктувате в тефтера.'
        : event.error === 'no-speech'
          ? 'Не чух реч. Опитайте отново.'
          : 'Гласовото въвеждане беше прекъснато. Опитайте отново.'
      setVoiceMessage(message)
      setListening(false)
    }

    recognition.onend = () => {
      setListening(false)
      setVoiceInterim('')
    }

    try {
      recognition.start()
      setListening(true)
    } catch {
      setVoiceMessage('Микрофонът не можа да бъде стартиран. Опитайте отново.')
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

                <button className="notebook-new-page" type="button" onClick={() => void addPage()} disabled={busy}>
                  ＋ Нова страница
                </button>
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

              <div className="notebook-composer">
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
                <div className="notebook-composer-actions">
                  <span>{draft.trim().length ? `${draft.trim().length} знака` : 'Записът ще се разпъва автоматично.'}</span>
                  <button type="button" onClick={() => void saveDraft()} disabled={!draft.trim() || busy}>
                    {busy ? 'Записване…' : 'Запиши задачата'}
                  </button>
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
                ) : pageEntries.map((entry, index) => (
                  <div
                    key={entry.id}
                    className={`notebook-entry${entry.completed ? ' completed' : ''}${entry.carried_from_date ? ' carried-over' : ''}`}
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
                      {entry.carried_from_date && (
                        <div className="notebook-carry-badge" title={`Прехвърлена от ${formatLongDate(entry.carried_from_date)}`}>
                          <span aria-hidden="true">↪</span>
                          <strong>От предния ден</strong>
                          <small>{formatCarryDate(entry.carried_from_date)}</small>
                        </div>
                      )}
                      {editingId === entry.id ? (
                        <textarea
                          className="notebook-edit-text"
                          rows={1}
                          value={editingText}
                          onChange={(event) => setEditingText(event.target.value)}
                          autoFocus
                        />
                      ) : (
                        <p>{entry.body}</p>
                      )}
                      <small>
                        {new Intl.DateTimeFormat('bg-BG', { hour: '2-digit', minute: '2-digit' }).format(new Date(entry.created_at))}
                        {entry.edited_at ? ' · редактирано' : ''}
                      </small>
                    </div>

                    <div className="notebook-entry-actions">
                      {editingId === entry.id ? (
                        <>
                          <button type="button" className="save" onClick={() => void saveEdit(entry)} disabled={!editingText.trim() || busy}>Запази</button>
                          <button type="button" onClick={() => setEditingId(null)}>Отказ</button>
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
                ))}
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
