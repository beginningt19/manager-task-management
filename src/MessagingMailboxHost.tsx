import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Session } from '@supabase/supabase-js'
import MessagingMailbox from './MessagingMailbox'
import { supabase } from './lib/supabase'
import type { Profile } from './types'

type MailToast = { tone: 'success' | 'error'; message: string }

export default function MessagingMailboxHost() {
  const [session, setSession] = useState<Session | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [target, setTarget] = useState<Element | null>(null)
  const [toast, setToast] = useState<MailToast | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session?.user.id) {
      setProfiles([])
      return
    }

    let cancelled = false
    const load = async () => {
      const { data } = await supabase.from('profiles').select('*').eq('is_active', true).order('display_name')
      if (!cancelled) setProfiles((data || []) as Profile[])
    }
    void load()

    const channel = supabase
      .channel(`mailbox-host-profiles-${session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => void load())
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [session?.user.id])

  useEffect(() => {
    if (!session?.user.id) {
      setTarget(null)
      return
    }

    const existing = document.querySelector('.account-area')
    if (existing) {
      setTarget(existing)
      return
    }

    const observer = new MutationObserver(() => {
      const next = document.querySelector('.account-area')
      if (!next) return
      setTarget(next)
      observer.disconnect()
    })

    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [session?.user.id])

  const userId = session?.user.id || ''
  const currentProfileExists = useMemo(() => profiles.some((profile) => profile.id === userId), [profiles, userId])

  const onResult = (result: MailToast) => {
    setToast(result)
    window.setTimeout(() => setToast(null), 4200)
  }

  if (!session || !target || !currentProfileExists) return null

  return createPortal(
    <>
      <MessagingMailbox userId={session.user.id} profiles={profiles} onResult={onResult} />
      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            zIndex: 2000,
            maxWidth: 420,
            padding: '12px 16px',
            borderRadius: 12,
            background: toast.tone === 'success' ? '#065f46' : '#991b1b',
            color: '#fff',
            boxShadow: '0 14px 35px rgba(15,23,42,.24)',
            fontWeight: 700,
          }}
        >
          {toast.message}
        </div>
      )}
    </>,
    target,
  )
}
