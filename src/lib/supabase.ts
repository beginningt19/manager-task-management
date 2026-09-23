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

const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis)

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

const requestUrl = (input: RequestInfo | URL) => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

const isSupabaseRestRequest = (input: RequestInfo | URL) => {
  const url = requestUrl(input)
  return url.includes('/rest/v1/')
}

const isJwtIssuedAtFutureResponse = async (response: Response) => {
  if (response.status !== 401) return false

  try {
    const payload = await response.clone().json() as { code?: string; message?: string }
    return payload?.code === 'PGRST303'
      && /jwt issued at future/i.test(payload?.message || '')
  } catch {
    try {
      const body = await response.clone().text()
      return /PGRST303/i.test(body) && /jwt issued at future/i.test(body)
    } catch {
      return false
    }
  }
}

// Hosted PostgREST has had an intermittent PGRST303 issue where the first
// request immediately after a freshly issued/refreshed JWT can be rejected as
// "JWT issued at future". Retry only that exact server-side rejection. A 401
// means the request was rejected before database execution, so retrying a
// mutation is safe in this specific case.
const resilientSupabaseFetch: typeof fetch = async (input, init) => {
  if (!isSupabaseRestRequest(input)) return nativeFetch(input, init)

  const retryDelays = [0, 300, 1200]

  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    const delay = retryDelays[attempt]
    if (delay) await wait(delay)

    const retryableInput =
      typeof Request !== 'undefined' && input instanceof Request
        ? input.clone()
        : input

    const response = await nativeFetch(retryableInput, init)
    const jwtFuture = await isJwtIssuedAtFutureResponse(response)

    if (!jwtFuture || attempt === retryDelays.length - 1) {
      return response
    }
  }

  return nativeFetch(input, init)
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
    global: {
      fetch: resilientSupabaseFetch,
    },
  },
)
