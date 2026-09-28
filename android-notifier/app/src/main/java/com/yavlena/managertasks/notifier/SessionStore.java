package com.yavlena.managertasks.notifier;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SessionStore {
    private static final String PREFS = "yavlena_manager_notifier_auth";
    private static final String KEY_ALIAS = "YavlenaManagerTaskNotifierSessionKey";
    private static final String EMAIL = "email";
    private static final String TOKEN = "refresh_token";

    static final class StoredSession {
        final String email;
        final String refreshToken;
        StoredSession(String email, String refreshToken) {
            this.email = email;
            this.refreshToken = refreshToken;
        }
    }

    static void save(Context context, String email, String refreshToken) throws Exception {
        byte[] encrypted = encrypt(refreshToken.getBytes(StandardCharsets.UTF_8));
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(EMAIL, email)
                .putString(TOKEN, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .commit();
    }

    static StoredSession load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String email = prefs.getString(EMAIL, null);
        String token = prefs.getString(TOKEN, null);
        if (email == null || token == null) return null;
        try {
            byte[] plain = decrypt(Base64.decode(token, Base64.NO_WRAP));
            return new StoredSession(email, new String(plain, StandardCharsets.UTF_8));
        } catch (Exception error) {
            return null;
        }
    }

    static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit();
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
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }

    private SessionStore() {}
}
