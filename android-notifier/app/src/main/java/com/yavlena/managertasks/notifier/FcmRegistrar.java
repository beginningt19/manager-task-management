package com.yavlena.managertasks.notifier;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class FcmRegistrar {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    static boolean isConfigured(Context context) {
        try {
            String appId = context.getString(com.yavlena.managertasks.notifier.R.string.google_app_id);
            String senderId = context.getString(com.yavlena.managertasks.notifier.R.string.gcm_defaultSenderId);
            String apiKey = context.getString(com.yavlena.managertasks.notifier.R.string.google_api_key);
            return appId != null && !appId.trim().isEmpty()
                    && senderId != null && !senderId.trim().isEmpty()
                    && apiKey != null && !apiKey.trim().isEmpty();
        } catch (Exception ignored) {
            return false;
        }
    }

    static void registerCurrentToken(Context context, SupabaseClient.AuthSession session) {
        if (!isConfigured(context) || session == null) return;
        try {
            FirebaseApp.initializeApp(context);
        } catch (Exception ignored) {}

        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null || task.getResult().trim().isEmpty()) return;
            registerToken(context, session, task.getResult());
        });
    }

    static void registerTokenFromStoredSession(Context context, String token) {
        if (!isConfigured(context) || token == null || token.trim().isEmpty()) return;
        SessionStore.StoredSession stored = SessionStore.load(context);
        if (stored == null) return;
        EXECUTOR.execute(() -> {
            try {
                SupabaseClient api = new SupabaseClient();
                SupabaseClient.AuthSession refreshed = api.refresh(stored.email, stored.refreshToken);
                SessionStore.save(context, refreshed.email, refreshed.refreshToken);
                api.registerMobilePushDevice(
                        refreshed.accessToken,
                        token,
                        deviceName(),
                        appVersion(context));
            } catch (Exception ignored) {}
        });
    }

    static void unregisterCurrentToken(Context context, SupabaseClient.AuthSession session) {
        if (!isConfigured(context) || session == null) return;
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) return;
            String token = task.getResult();
            EXECUTOR.execute(() -> {
                try {
                    new SupabaseClient().deleteMobilePushDevice(session.accessToken, token);
                } catch (Exception ignored) {}
                FirebaseMessaging.getInstance().deleteToken();
            });
        });
    }

    private static void registerToken(Context context, SupabaseClient.AuthSession session, String token) {
        EXECUTOR.execute(() -> {
            try {
                new SupabaseClient().registerMobilePushDevice(
                        session.accessToken,
                        token,
                        deviceName(),
                        appVersion(context));
            } catch (Exception ignored) {}
        });
    }

    private static String appVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "1.1.0" : info.versionName;
        } catch (Exception ignored) {
            return "1.1.0";
        }
    }

    private static String deviceName() {
        String manufacturer = Build.MANUFACTURER == null ? "Android" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "device" : Build.MODEL.trim();
        if (model.toLowerCase().startsWith(manufacturer.toLowerCase())) return model;
        return manufacturer + " " + model;
    }

    private FcmRegistrar() {}
}
