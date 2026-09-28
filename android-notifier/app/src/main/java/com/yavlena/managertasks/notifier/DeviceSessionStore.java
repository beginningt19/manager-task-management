package com.yavlena.managertasks.notifier;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class DeviceSessionStore {
    private static final String PREFS = "yavlena_manager_notifier_device_session";
    private static final String KEY_ALIAS = "YavlenaManagerNotifierPersistentDeviceKey";
    private static final String EMAIL = "email";
    private static final String DEVICE_TOKEN = "device_token";
    private static final String DEVICE_ID = "device_id";

    static final class StoredDeviceSession {
        final String email;
        final String deviceToken;
        final String deviceId;

        StoredDeviceSession(String email, String deviceToken, String deviceId) {
            this.email = email;
            this.deviceToken = deviceToken;
            this.deviceId = deviceId;
        }

        SupabaseClient.DeviceSession toSession() {
            return new SupabaseClient.DeviceSession(email, deviceToken);
        }
    }

    static String getOrCreateDeviceId(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String current = prefs.getString(DEVICE_ID, null);
        if (current != null && !current.trim().isEmpty()) return current;

        String created = UUID.randomUUID().toString();
        prefs.edit().putString(DEVICE_ID, created).commit();
        return created;
    }

    static void save(Context context, SupabaseClient.DeviceSession session) throws Exception {
        String deviceId = getOrCreateDeviceId(context);
        byte[] encrypted = encrypt(session.deviceToken.getBytes(StandardCharsets.UTF_8));
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(EMAIL, session.email)
                .putString(DEVICE_TOKEN, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(DEVICE_ID, deviceId)
                .commit();
    }

    static StoredDeviceSession load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String email = prefs.getString(EMAIL, null);
        String encryptedToken = prefs.getString(DEVICE_TOKEN, null);
        String deviceId = prefs.getString(DEVICE_ID, null);
        if (email == null || encryptedToken == null || deviceId == null) return null;

        try {
            byte[] plain = decrypt(Base64.decode(encryptedToken, Base64.NO_WRAP));
            String token = new String(plain, StandardCharsets.UTF_8);
            if (token.trim().isEmpty()) return null;
            return new StoredDeviceSession(email, token, deviceId);
        } catch (Exception ignored) {
            // Never erase the stored persistent session automatically.
            return null;
        }
    }

    static void clearSession(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String deviceId = prefs.getString(DEVICE_ID, null);
        SharedPreferences.Editor editor = prefs.edit().clear();
        if (deviceId != null && !deviceId.trim().isEmpty()) {
            editor.putString(DEVICE_ID, deviceId);
        }
        editor.commit();
    }

    private static byte[] encrypt(byte[] plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] body = cipher.doFinal(plain);
        byte[] combined = new byte[1 + iv.length + body.length];
        combined[0] = (byte) iv.length;
        System.arraycopy(iv, 0, combined, 1, iv.length);
        System.arraycopy(body, 0, combined, 1 + iv.length, body.length);
        return combined;
    }

    private static byte[] decrypt(byte[] combined) throws Exception {
        int ivLength = combined[0] & 0xff;
        byte[] iv = new byte[ivLength];
        byte[] body = new byte[combined.length - 1 - ivLength];
        System.arraycopy(combined, 1, iv, 0, ivLength);
        System.arraycopy(combined, 1 + ivLength, body, 0, body.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return cipher.doFinal(body);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_NONE)
                .build());
        return generator.generateKey();
    }

    private DeviceSessionStore() {}
}
