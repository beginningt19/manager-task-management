package com.yavlena.managertasks.notifier;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

final class SupabaseClient {
    static final class AuthException extends IOException {
        final boolean invalidSession;

        AuthException(String message, boolean invalidSession) {
            super(message);
            this.invalidSession = invalidSession;
        }
    }

    private static final String BASE_URL = "https://xrcvfzqwhqtoljfxgxgr.supabase.co";
    private static final String API_KEY = "sb_publishable_K9eOz-sxjizM7fkHrWXOeA_zu-9ijLu";

    static final class AuthSession {
        final String email;
        final String accessToken;
        final String refreshToken;
        AuthSession(String email, String accessToken, String refreshToken) {
            this.email = email;
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
        }
    }

    static final class Reminder {
        final String id;
        final String taskId;
        final Instant remindAt;
        final String description;
        final boolean completed;

        Reminder(String id, String taskId, Instant remindAt, String description, boolean completed) {
            this.id = id;
            this.taskId = taskId;
            this.remindAt = remindAt;
            this.description = description;
            this.completed = completed;
        }
    }

    AuthSession login(String email, String password) throws Exception {
        JSONObject body = new JSONObject();
        body.put("email", email);
        body.put("password", password);
        return authRequest("/auth/v1/token?grant_type=password", body, email);
    }

    AuthSession refresh(String email, String refreshToken) throws Exception {
        JSONObject body = new JSONObject();
        body.put("refresh_token", refreshToken);
        return authRequest("/auth/v1/token?grant_type=refresh_token", body, email);
    }

    void registerMobilePushDevice(String accessToken, String fcmToken, String deviceName, String appVersion) throws Exception {
        JSONObject user = new JSONObject(request("GET", "/auth/v1/user", null, accessToken));
        String userId = user.getString("id");

        JSONObject body = new JSONObject();
        body.put("user_id", userId);
        body.put("fcm_token", fcmToken);
        body.put("platform", "android");
        body.put("device_name", deviceName);
        body.put("app_version", appVersion);
        body.put("last_seen_at", Instant.now().toString());
        body.put("updated_at", Instant.now().toString());

        request(
                "POST",
                "/rest/v1/mobile_push_devices?on_conflict=fcm_token",
                body.toString(),
                accessToken,
                "resolution=merge-duplicates,return=minimal");
    }

    void deleteMobilePushDevice(String accessToken, String fcmToken) throws Exception {
        request(
                "DELETE",
                "/rest/v1/mobile_push_devices?fcm_token=eq." + encode(fcmToken),
                null,
                accessToken,
                "return=minimal");
    }

    List<Reminder> fetchReminders(String accessToken, Instant from, Instant to) throws Exception {
        String select = encode("id,task_id,remind_at,tasks(description,status,completed_at)");
        String path = "/rest/v1/task_reminders?select=" + select
                + "&remind_at=gte." + encode(from.toString())
                + "&remind_at=lte." + encode(to.toString())
                + "&order=remind_at.asc";
        String text = request("GET", path, null, accessToken);
        JSONArray rows = new JSONArray(text);
        List<Reminder> result = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            JSONObject task = row.optJSONObject("tasks");
            String description = task == null ? "Задача" : task.optString("description", "Задача");
            String status = task == null ? "" : task.optString("status", "");
            boolean completed = task == null || "completed".equals(status) || !task.isNull("completed_at");
            result.add(new Reminder(
                    row.getString("id"),
                    row.getString("task_id"),
                    Instant.parse(row.getString("remind_at")),
                    description,
                    completed));
        }
        return result;
    }

    private AuthSession authRequest(String path, JSONObject body, String email) throws Exception {
        String text = request("POST", path, body.toString(), null);
        JSONObject json = new JSONObject(text);
        String access = json.optString("access_token", null);
        String refresh = json.optString("refresh_token", null);
        if (access == null || refresh == null) throw new IOException("Supabase не върна валидна сесия.");
        return new AuthSession(email, access, refresh);
    }

    private String request(String method, String path, String body, String accessToken) throws Exception {
        return request(method, path, body, accessToken, null);
    }

    private String request(String method, String path, String body, String accessToken, String prefer) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE_URL + path).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(20_000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("apikey", API_KEY);
        connection.setRequestProperty("Accept", "application/json");
        if (accessToken != null) connection.setRequestProperty("Authorization", "Bearer " + accessToken);
        if (prefer != null) connection.setRequestProperty("Prefer", prefer);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }

        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = readAll(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) {
            String message = "Грешка при връзка със Supabase (" + code + ").";
            String errorCode = "";
            try {
                JSONObject error = new JSONObject(text);
                if (error.has("error_description")) message = error.getString("error_description");
                else if (error.has("msg")) message = error.getString("msg");
                else if (error.has("message")) message = error.getString("message");
                errorCode = error.optString("error_code", "");
            } catch (Exception ignored) {}

            boolean refreshRequest = path.contains("grant_type=refresh_token");
            boolean invalidRefresh = refreshRequest && code == 400
                    && ("refresh_token_not_found".equals(errorCode)
                    || message.toLowerCase().contains("invalid refresh token")
                    || message.toLowerCase().contains("refresh token not found"));
            if (invalidRefresh) throw new AuthException(message, true);
            throw new IOException(message);
        }
        return text;
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20");
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
