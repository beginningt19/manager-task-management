package com.yavlena.managertasks.notifier;

import android.content.Context;

final class SessionManager {
    private static final Object REFRESH_LOCK = new Object();

    static SupabaseClient.AuthSession refreshStored(Context context) throws Exception {
        synchronized (REFRESH_LOCK) {
            SessionStore.StoredSession stored = SessionStore.load(context);
            if (stored == null) {
                throw new SupabaseClient.AuthException("Липсва запазена сесия.", true);
            }

            SupabaseClient.AuthSession refreshed =
                    new SupabaseClient().refresh(stored.email, stored.refreshToken);
            SessionStore.save(context, refreshed.email, refreshed.refreshToken);
            return refreshed;
        }
    }

    static void save(Context context, SupabaseClient.AuthSession session) throws Exception {
        synchronized (REFRESH_LOCK) {
            SessionStore.save(context, session.email, session.refreshToken);
        }
    }

    static void clear(Context context) {
        synchronized (REFRESH_LOCK) {
            SessionStore.clear(context);
        }
    }

    private SessionManager() {}
}
