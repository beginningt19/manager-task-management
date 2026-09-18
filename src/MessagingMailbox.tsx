import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from './lib/supabase'
import type { Profile } from './types'
import './messaging-mailbox.css'

type MailTab = 'inbox' | 'sent'
type MailToast = { tone: 'success' | 'error'; message: string }

type InternalMessage = {
  id: string
  sender_id: string
  sender_name: string
  subject: string | null
  body: string
  created_at: string
}

type InternalRecipient = {
  message_id: string
  recipient_user_id: string
  read_at: string | null
  created_at: string
}

type Props = {
  userId: string
  profiles: Profile[]
  onResult: (result: MailToast) => void
}

const formatMailDate = (value: string) => new Intl.DateTimeFormat('bg-BG', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(value))

const previewText = (message: InternalMessage) =>
  (message.subject?.trim() || message.body.trim()).replace(/\s+/g, ' ')

export default function MessagingMailbox({ userId, profiles, onResult }: Props) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<MailTab>('inbox')
  const [composeOpen, setComposeOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [messages, setMessages] = useState<InternalMessage[]>([])
  const [recipients, setRecipients] = useState<InternalRecipient[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [recipientIds, setRecipientIds] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const activeRecipients = useMemo(
    () => profiles.filter((person) => person.is_active && person.id !== userId),
    [profiles, userId],
  )
  const profileById = useMemo(() => new Map(profiles.map((person) => [person.id, person])), [profiles])

  const loadMailbox = useCallback(async (quiet = false) => {
    setLoading(true)
    const [messagesResult, recipientsResult] = await Promise.all([
      supabase.from('internal_messages').select('*').order('created_at', { ascending: false }).limit(300),
      supabase.from('internal_message_recipients').select('*').order('created_at', { ascending: false }).limit(1000),
    ])

    const firstError = messagesResult.error || recipientsResult.error
    if (firstError) {
      setReady(false)
      setUnavailable(true)
      setLoading(false)
      if (!quiet && !firstError.message.toLowerCase().includes('internal_messages')) {
        onResult({ tone: 'error', message: firstError.message })
      }
      return
    }

    setMessages((messagesResult.data || []) as InternalMessage[])
    setRecipients((recipientsResult.data || []) as InternalRecipient[])
    setUnavailable(false)
    setReady(true)
    setLoading(false)
  }, [onResult])

  useEffect(() => {
    void loadMailbox(true)
  }, [loadMailbox, userId])

  useEffect(() => {
    if (!ready) return
    const channel = supabase
      .channel(`internal-mailbox-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_messages' }, () => void loadMailbox(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_message_recipients' }, () => void loadMailbox(true))
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadMailbox, ready, userId])

  const messageById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])

  const inbox = useMemo(() => recipients
    .filter((recipient) => recipient.recipient_user_id === userId)
    .map((recipient) => ({ recipient, message: messageById.get(recipient.message_id) }))
    .filter((entry): entry is { recipient: InternalRecipient; message: InternalMessage } => Boolean(entry.message))
    .sort((a, b) => b.message.created_at.localeCompare(a.message.created_at)),
  [messageById, recipients, userId])

  const sent = useMemo(() => messages
    .filter((message) => message.sender_id === userId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at)),
  [messages, userId])

  const recipientIdsByMessage = useMemo(() => {
    const result = new Map<string, string[]>()
    recipients.forEach((recipient) => {
      const current = result.get(recipient.message_id) || []
      current.push(recipient.recipient_user_id)
      result.set(recipient.message_id, current)
    })
    return result
  }, [recipients])

  const unreadCount = useMemo(
    () => inbox.filter((entry) => !entry.recipient.read_at).length,
    [inbox],
  )

  const visibleMessages = tab === 'inbox' ? inbox.map((entry) => entry.message) : sent
  const selected = selectedId ? messageById.get(selectedId) || null : null
  const selectedInboxRecipient = tab === 'inbox' && selectedId
    ? inbox.find((entry) => entry.message.id === selectedId)?.recipient || null
    : null

  useEffect(() => {
    if (!open || composeOpen) return
    if (visibleMessages.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !visibleMessages.some((message) => message.id === selectedId)) {
      setSelectedId(visibleMessages[0].id)
    }
  }, [composeOpen, open, selectedId, visibleMessages])

  const markRead = async (messageId: string) => {
    const row = recipients.find((recipient) => recipient.message_id === messageId && recipient.recipient_user_id === userId)
    if (!row || row.read_at) return

    const now = new Date().toISOString()
    setRecipients((current) => current.map((recipient) =>
      recipient.message_id === messageId && recipient.recipient_user_id === userId
        ? { ...recipient, read_at: now }
        : recipient,
    ))

    const { error } = await supabase.rpc('mark_internal_message_read', { p_message_id: messageId })
    if (error) {
      setRecipients((current) => current.map((recipient) =>
        recipient.message_id === messageId && recipient.recipient_user_id === userId
          ? { ...recipient, read_at: null }
          : recipient,
      ))
      onResult({ tone: 'error', message: error.message })
    }
  }

  const selectMessage = (messageId: string) => {
    setComposeOpen(false)
    setSelectedId(messageId)
    if (tab === 'inbox') void markRead(messageId)
  }

  const openMailbox = () => {
    setOpen(true)
    void loadMailbox(true)
  }

  const openCompose = (replyTo?: InternalMessage) => {
    setComposeOpen(true)
    setSelectedId(null)
    if (replyTo) {
      setRecipientIds([replyTo.sender_id])
      setSubject(replyTo.subject ? `Re: ${replyTo.subject.replace(/^Re:\s*/i, '')}` : '')
    } else {
      setRecipientIds([])
      setSubject('')
    }
    setBody('')
  }

  const toggleRecipient = (recipientId: string) => {
    setRecipientIds((current) => current.includes(recipientId)
      ? current.filter((id) => id !== recipientId)
      : [...current, recipientId])
  }

  const toggleAllRecipients = () => {
    const allIds = activeRecipients.map((person) => person.id)
    const allSelected = allIds.length > 0 && allIds.every((id) => recipientIds.includes(id))
    setRecipientIds(allSelected ? [] : allIds)
  }

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()
    if (recipientIds.length === 0) {
      onResult({ tone: 'error', message: 'Изберете поне един получател.' })
      return
    }
    if (!body.trim()) {
      onResult({ tone: 'error', message: 'Напишете съобщение.' })
      return
    }

    setSending(true)
    const { data, error } = await supabase.rpc('send_internal_message', {
      p_recipient_ids: recipientIds,
      p_body: body.trim(),
      p_subject: subject.trim() || null,
    })
    setSending(false)

    if (error) {
      onResult({ tone: 'error', message: error.message })
      return
    }

    onResult({
      tone: 'success',
      message: recipientIds.length === 1 ? 'Съобщението е изпратено.' : `Съобщението е изпратено до ${recipientIds.length} души.`,
    })
    setComposeOpen(false)
    setRecipientIds([])
    setSubject('')
    setBody('')
    setTab('sent')
    await loadMailbox(true)
    if (typeof data === 'string') setSelectedId(data)
  }

  const sentTo = (messageId: string) => (recipientIdsByMessage.get(messageId) || [])
    .map((id) => profileById.get(id)?.display_name || 'Потребител')
    .join(', ')

  return (
    <>
      <button className="notification-button checklist-launch mailbox-launch" onClick={openMailbox} title="Отвори съобщенията">
        ✉<span>Съобщения</span>
        {unreadCount > 0 && <b className="mailbox-badge" aria-label={`${unreadCount} непрочетени`}>{unreadCount > 9 ? '9+' : unreadCount}</b>}
      </button>

      {open && (
        <div className="mailbox-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}>
          <section className="mailbox-shell" role="dialog" aria-modal="true" aria-label="Съобщения">
            <header className="mailbox-header">
              <div>
                <span className="mailbox-kicker">Вътрешна поща</span>
                <h2>Съобщения</h2>
              </div>
              <div className="mailbox-header-actions">
                <button className="mailbox-compose-button" onClick={() => openCompose()}>＋ Ново съобщение</button>
                <button className="mailbox-close" onClick={() => setOpen(false)} aria-label="Затвори">×</button>
              </div>
            </header>

            {unavailable ? (
              <div className="mailbox-unavailable">
                <strong>Пощата още не е активирана в базата данни.</strong>
                <span>Кодът е готов; необходимо е да се приложи Supabase миграцията за този проект.</span>
                <button onClick={() => void loadMailbox(false)}>Провери отново</button>
              </div>
            ) : (
              <>
                <nav className="mailbox-tabs" aria-label="Папки">
                  <button className={tab === 'inbox' ? 'active' : ''} onClick={() => { setTab('inbox'); setComposeOpen(false) }}>
                    Входящи {unreadCount > 0 && <span>{unreadCount}</span>}
                  </button>
                  <button className={tab === 'sent' ? 'active' : ''} onClick={() => { setTab('sent'); setComposeOpen(false) }}>
                    Изпратени
                  </button>
                </nav>

                <div className="mailbox-content">
                  <aside className="mailbox-list" aria-label={tab === 'inbox' ? 'Входящи съобщения' : 'Изпратени съобщения'}>
                    {loading && visibleMessages.length === 0 && <div className="mailbox-empty">Зареждане…</div>}
                    {!loading && visibleMessages.length === 0 && (
                      <div className="mailbox-empty">
                        <strong>{tab === 'inbox' ? 'Нямате входящи съобщения' : 'Нямате изпратени съобщения'}</strong>
                        <span>{tab === 'inbox' ? 'Новите съобщения ще се появяват тук.' : 'Изпратете първото съобщение от бутона горе.'}</span>
                      </div>
                    )}
                    {visibleMessages.map((message) => {
                      const inboxEntry = inbox.find((entry) => entry.message.id === message.id)
                      const unread = tab === 'inbox' && !inboxEntry?.recipient.read_at
                      return (
                        <button
                          key={message.id}
                          className={`mailbox-row${selectedId === message.id && !composeOpen ? ' selected' : ''}${unread ? ' unread' : ''}`}
                          onClick={() => selectMessage(message.id)}
                        >
                          <div className="mailbox-row-top">
                            <strong>{tab === 'inbox' ? message.sender_name : `До: ${sentTo(message.id) || '—'}`}</strong>
                            <time>{formatMailDate(message.created_at)}</time>
                          </div>
                          <span className="mailbox-row-subject">{message.subject || '(без тема)'}</span>
                          <small>{previewText(message)}</small>
                          {unread && <i aria-label="Непрочетено" />}
                        </button>
                      )
                    })}
                  </aside>

                  <main className="mailbox-reader">
                    {composeOpen ? (
                      <form className="mailbox-compose" onSubmit={sendMessage}>
                        <div className="mailbox-compose-title">
                          <div>
                            <span className="mailbox-kicker">Ново</span>
                            <h3>Напиши съобщение</h3>
                          </div>
                          <button type="button" onClick={() => setComposeOpen(false)}>Отказ</button>
                        </div>

                        <fieldset className="mailbox-recipient-picker">
                          <div className="mailbox-recipient-heading">
                            <legend>До</legend>
                            {activeRecipients.length > 1 && <button type="button" onClick={toggleAllRecipients}>Избери всички</button>}
                          </div>
                          <div className="mailbox-recipient-grid">
                            {activeRecipients.map((person) => (
                              <label key={person.id} className={recipientIds.includes(person.id) ? 'selected' : ''}>
                                <input
                                  type="checkbox"
                                  checked={recipientIds.includes(person.id)}
                                  onChange={() => toggleRecipient(person.id)}
                                />
                                <span className="mailbox-recipient-avatar">{person.display_name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span>
                                <span>
                                  <strong>{person.display_name}</strong>
                                  <small>{person.display_role || (person.role === 'manager' ? 'Мениджър' : 'Модератор')}</small>
                                </span>
                              </label>
                            ))}
                          </div>
                        </fieldset>

                        <label className="mailbox-field">
                          <span>Тема <small>(по желание)</small></span>
                          <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={160} placeholder="Например: Документи за оперативката" />
                        </label>

                        <label className="mailbox-field mailbox-body-field">
                          <span>Съобщение</span>
                          <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} placeholder="Напишете съобщението…" autoFocus />
                          <small>{body.length}/5000</small>
                        </label>

                        <div className="mailbox-compose-footer">
                          <span>{recipientIds.length === 0 ? 'Няма избран получател' : `Получатели: ${recipientIds.length}`}</span>
                          <button type="submit" disabled={sending || recipientIds.length === 0 || !body.trim()}>
                            {sending ? 'Изпращане…' : 'Изпрати ✉'}
                          </button>
                        </div>
                      </form>
                    ) : selected ? (
                      <article className="mailbox-message">
                        <header>
                          <span className="mailbox-kicker">{tab === 'inbox' ? 'Получено съобщение' : 'Изпратено съобщение'}</span>
                          <h3>{selected.subject || '(без тема)'}</h3>
                          <div className="mailbox-message-meta">
                            <div>
                              <strong>{tab === 'inbox' ? `От: ${selected.sender_name}` : `До: ${sentTo(selected.id) || '—'}`}</strong>
                              <span>{formatMailDate(selected.created_at)}</span>
                            </div>
                            {tab === 'inbox' && selectedInboxRecipient && (
                              <span className={`mailbox-read-state${selectedInboxRecipient.read_at ? ' read' : ''}`}>
                                {selectedInboxRecipient.read_at ? 'Прочетено' : 'Непрочетено'}
                              </span>
                            )}
                          </div>
                        </header>
                        <div className="mailbox-message-body">{selected.body}</div>
                        {tab === 'inbox' && selected.sender_id !== userId && (
                          <footer>
                            <button onClick={() => openCompose(selected)}>↩ Отговори</button>
                          </footer>
                        )}
                      </article>
                    ) : (
                      <div className="mailbox-reader-empty">
                        <span>✉</span>
                        <strong>Изберете съобщение</strong>
                        <small>или създайте ново от бутона горе.</small>
                      </div>
                    )}
                  </main>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  )
}
