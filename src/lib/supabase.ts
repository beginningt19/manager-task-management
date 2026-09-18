import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const configurationError =
  !supabaseUrl || !supabaseKey
    ? 'Липсват VITE_SUPABASE_URL или VITE_SUPABASE_PUBLISHABLE_KEY.'
    : null

const managerAuthStorageKey = 'yavlena-manager-auth'
const legacySupabaseStorageKey = 'sb-xrcvfzqwhqtoljfxgxgr-auth-token'

const browserStorage = typeof window !== 'undefined'
  ? window.localStorage
  : undefined

if (browserStorage && !browserStorage.getItem(managerAuthStorageKey)) {
  const legacySession = browserStorage.getItem(legacySupabaseStorageKey)
  if (legacySession) browserStorage.setItem(managerAuthStorageKey, legacySession)
}

// Keep a stable, explicit localStorage key so the Manager session survives
// tab closes, browser restarts and PWA re-opens until the user signs out.
export const supabase = createClient(
  supabaseUrl || 'https://invalid.local',
  supabaseKey || 'missing-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: browserStorage,
      storageKey: managerAuthStorageKey,
      flowType: 'pkce',
    },
  },
)
