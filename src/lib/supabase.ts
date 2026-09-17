import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const configurationError =
  !supabaseUrl || !supabaseKey
    ? 'Липсват VITE_SUPABASE_URL или VITE_SUPABASE_PUBLISHABLE_KEY.'
    : null

export const supabase = createClient(
  supabaseUrl || 'https://invalid.local',
  supabaseKey || 'missing-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
)
