package com.yavlena.managertasks.notifier;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

final class SupabaseClient {
    private static final String BASE_URL = "https://xrcvfzqwhqtoljfxgxgr.supabase.co";
    private static final String API_KEY = "sb_publishable_K9eOz-sxjizM7fkHrWXOeA_zu-9ijLu";

    static final class AuthSession {
        final String email, accessToken, refreshToken;
        AuthSession(String email, String accessToken, String refreshToken) {
            this.email = email; this.accessToken = accessToken; this.refreshToken = refreshToken;
        }
    }

    static final class Reminder {
        final String id, taskId, description;
        final Instant remindAt;
        final boolean completed;
        Reminder(String id, String taskId, Instant remindAt, String description, boolean completed) {
            this.id = id; this.taskId = taskId; this.remindAt = remindAt; this.description = description; this.completed = completed;
        }
    }

    AuthSession login(String email, String password) throws Exception {
        JSONObject body = new JSONObject().put("email", email).put("password", password);
        return authRequest("/auth/v1/token?grant_type=password", body, email);
    }

    AuthSession refresh(String email, String refreshToken) throws Exception {
        JSONObject body = new JSONObject().put("refresh_token", refreshToken);
        return authRequest("/auth/v1/token?grant_type=refresh_token", body, email);
    }

    List<Reminder> fetchReminders(String accessToken, Instant from, Instant to) throws Exception {
        String select = encode("id,task_id,remind_at,tasks(description,status,completed_at)");
        String path = "/rest/v1/task_reminders?select=" + select
                + "&remind_at=gte." + encode(from.toString())
                + "&remind_at=lte." + encode(to.toString())
                + "&order=remind_at.asc";
        JSONArray rows = new JSONArray(request("GET", path, null, accessToken));
        List<Reminder> result = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            JSONObject task = row.optJSONObject("tasks");
            String description = task == null ? "Задача" : task.optString("description", "Задача");
            String status = task == null ? "" : task.optString("status", "");
            boolean completed = task == null || "completed".equals(status) || !task.isNull("completed_at");
            result.add(new Reminder(row.getString("id"), row.getString("task_id"), Instant.parse(row.getString("remind_at")), description, completed));
        }
        return result;
    }

    private AuthSession authRequest(String path, JSONObject body, String email) throws Exception {
        JSONObject json = new JSONObject(request("POST", path, body.toString(), null));
        String access = json.optString("access_token", null);
        String refresh = json.optString("refresh_token", null);
        if (access == null || refresh == null) throw new IOException("Supabase не върна валидна сесия.");
        return new AuthSession(email, access, refresh);
    }

    private String request(String method, String path, String body, String accessToken) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE_URL + path).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(20000); c.setRequestMethod(method);
        c.setRequestProperty("apikey", API_KEY); c.setRequestProperty("Accept", "application/json");
        if (accessToken != null) c.setRequestProperty("Authorization", "Bearer " + accessToken);
        if (body != null) {
            c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        int code = c.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
        String text = readAll(stream); c.disconnect();
        if (code < 200 || code >= 300) {
            String message = "Грешка при връзка със Supabase (" + code + ").";
            try {
                JSONObject error = new JSONObject(text);
                if (error.has("error_description")) message = error.getString("error_description");
                else if (error.has("msg")) message = error.getString("msg");
                else if (error.has("message")) message = error.getString("message");
            } catch (Exception ignored) {}
            throw new IOException(message);
        }
        return text;
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line; while ((line = r.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private static String encode(String value) {
        try { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20"); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
}
