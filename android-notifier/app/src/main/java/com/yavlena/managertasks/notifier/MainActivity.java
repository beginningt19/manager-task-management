package com.yavlena.managertasks.notifier;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 2001;
    private static final String WEB_URL = "https://manager-task-management.pages.dev/";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private SupabaseClient.AuthSession session;
    private LinearLayout root;
    private TextView status;
    private Button exactAlarmButton;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NotificationHelper.ensureChannel(this);
        showLoading();
        SessionStore.StoredSession stored = SessionStore.load(this);
        if (stored == null) { showLogin(); return; }
        executor.execute(() -> {
            try {
                SupabaseClient.AuthSession refreshed = new SupabaseClient().refresh(stored.email, stored.refreshToken);
                SessionStore.save(this, refreshed.email, refreshed.refreshToken);
                session = refreshed;
                runOnUiThread(() -> { showDashboard(); requestNotificationPermissionIfNeeded(); syncNow(); });
            } catch (Exception error) {
                SessionStore.clear(this);
                runOnUiThread(this::showLogin);
            }
        });
    }

    @Override protected void onResume() {
        super.onResume();
        if (session != null && exactAlarmButton != null) updatePermissionStatus();
    }

    @Override protected void onDestroy() { executor.shutdownNow(); super.onDestroy(); }

    private void showLoading() {
        root = baseRoot();
        TextView loading = text("Зареждане…", 18, Color.DKGRAY); loading.setGravity(Gravity.CENTER);
        root.addView(loading, matchWrap()); setContentView(wrap(root));
    }

    private void showLogin() {
        session = null; root = baseRoot();
        root.addView(title("Yavlena Manager Notifier"));
        root.addView(text("Нативни Android напомняния за управленските задачи. Браузърът не е необходим.", 15, Color.DKGRAY));
        spacer(18);
        EditText email = input("Имейл", false), password = input("Парола", true);
        root.addView(email, matchWrap()); spacer(10); root.addView(password, matchWrap()); spacer(16);
        Button login = primaryButton("Вход и включване на напомнянията");
        TextView loginStatus = text("", 14, Color.rgb(180,40,40));
        root.addView(login, matchWrap()); spacer(8); root.addView(loginStatus, matchWrap());
        login.setOnClickListener(v -> {
            String emailValue = email.getText().toString().trim(), passwordValue = password.getText().toString();
            if (emailValue.isEmpty() || passwordValue.isEmpty()) { loginStatus.setText("Попълнете имейл и парола."); return; }
            login.setEnabled(false); loginStatus.setText("Вход…");
            executor.execute(() -> {
                try {
                    SupabaseClient.AuthSession loggedIn = new SupabaseClient().login(emailValue, passwordValue);
                    SessionStore.save(this, loggedIn.email, loggedIn.refreshToken); session = loggedIn;
                    ReminderSyncWorker.ensurePeriodic(this);
                    runOnUiThread(() -> { showDashboard(); requestNotificationPermissionIfNeeded(); syncNow(); });
                } catch (Exception error) {
                    runOnUiThread(() -> { login.setEnabled(true); loginStatus.setText(error.getMessage() == null ? "Неуспешен вход." : error.getMessage()); });
                }
            });
        });
        setContentView(wrap(root));
    }

    private void showDashboard() {
        root = baseRoot();
        root.addView(title("Yavlena Manager Notifier"));
        root.addView(text("Включено за: " + session.email, 15, Color.DKGRAY)); spacer(16);
        status = text("Проверка на напомнянията…", 15, Color.rgb(32,72,145));
        status.setPadding(dp(14),dp(14),dp(14),dp(14)); status.setBackgroundColor(Color.rgb(236,243,255));
        root.addView(status, matchWrap()); spacer(14);
        exactAlarmButton = secondaryButton("Разреши точни аларми"); exactAlarmButton.setOnClickListener(v -> openExactAlarmSettings());
        root.addView(exactAlarmButton, matchWrap()); spacer(10);
        Button sync = primaryButton("Синхронизирай сега"); sync.setOnClickListener(v -> syncNow()); root.addView(sync, matchWrap()); spacer(10);
        Button openWeb = secondaryButton("Отвори Manager Task Management");
        openWeb.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(WEB_URL)))); root.addView(openWeb, matchWrap()); spacer(24);
        root.addView(text("Как работи:\n\n• Напомнянията се синхронизират от Manager Task Management.\n• Телефонът насрочва точен Android alarm за избрания час.\n• Периодичната синхронизация през 15+ минути служи като резервен механизъм.\n• След рестарт на телефона графикът се възстановява автоматично.", 14, Color.DKGRAY), matchWrap());
        spacer(24);
        Button logout = secondaryButton("Изход от акаунта на този телефон");
        logout.setOnClickListener(v -> { ReminderSyncWorker.cancelAll(this); ReminderScheduler.clear(this); SessionStore.clear(this); session = null; showLogin(); });
        root.addView(logout, matchWrap()); setContentView(wrap(root));
        ReminderSyncWorker.ensurePeriodic(this); updatePermissionStatus();
    }

    private void syncNow() {
        if (session == null || status == null) return;
        status.setText("Синхронизиране…");
        executor.execute(() -> {
            try {
                SessionStore.StoredSession stored = SessionStore.load(this);
                if (stored == null) throw new IllegalStateException("Липсва запазена сесия.");
                SupabaseClient.AuthSession refreshed = new SupabaseClient().refresh(stored.email, stored.refreshToken);
                SessionStore.save(this, refreshed.email, refreshed.refreshToken); session = refreshed;
                ReminderScheduler.SyncResult result = ReminderScheduler.sync(this, refreshed);
                ReminderSyncWorker.ensurePeriodic(this);
                runOnUiThread(() -> {
                    String exactText = result.exactAlarms ? "Точните аларми са разрешени." : "Точните аларми НЕ са разрешени — Android може да забави известията.";
                    status.setText("Синхронизирано. Насрочени бъдещи напомняния: " + result.scheduled + ".\n" + exactText);
                    updatePermissionStatus();
                });
            } catch (Exception error) {
                runOnUiThread(() -> status.setText("Грешка при синхронизация: " + (error.getMessage() == null ? "неизвестна грешка" : error.getMessage())));
            }
        });
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
    }

    private void openExactAlarmSettings() {
        if (Build.VERSION.SDK_INT < 31) return;
        AlarmManager alarmManager = getSystemService(AlarmManager.class);
        if (alarmManager.canScheduleExactAlarms()) { Toast.makeText(this, "Точните аларми вече са разрешени.", Toast.LENGTH_SHORT).show(); return; }
        startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName())));
    }

    private void updatePermissionStatus() {
        if (exactAlarmButton == null) return;
        boolean exact = Build.VERSION.SDK_INT < 31 || getSystemService(AlarmManager.class).canScheduleExactAlarms();
        exactAlarmButton.setVisibility(exact ? View.GONE : View.VISIBLE);
    }

    private LinearLayout baseRoot() {
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(22),dp(28),dp(22),dp(32)); layout.setBackgroundColor(Color.rgb(244,248,255)); return layout;
    }
    private ScrollView wrap(View content) { ScrollView scroll = new ScrollView(this); scroll.addView(content, new ScrollView.LayoutParams(-1,-2)); return scroll; }
    private TextView title(String value) { TextView t = text(value,26,Color.rgb(38,94,196)); t.setTypeface(Typeface.DEFAULT, Typeface.BOLD); t.setPadding(0,0,0,dp(8)); return t; }
    private TextView text(String value,int sp,int color) { TextView v = new TextView(this); v.setText(value); v.setTextSize(sp); v.setTextColor(color); v.setLineSpacing(0,1.12f); return v; }
    private EditText input(String hint, boolean password) { EditText e = new EditText(this); e.setHint(hint); e.setTextSize(16); e.setSingleLine(true); e.setPadding(dp(14),dp(12),dp(14),dp(12)); e.setBackgroundColor(Color.WHITE); e.setInputType(password ? 0x81 : 0x21); return e; }
    private Button primaryButton(String label) { Button b = new Button(this); b.setText(label); b.setTextSize(15); b.setTextColor(Color.WHITE); b.setBackgroundColor(Color.rgb(38,94,196)); b.setAllCaps(false); b.setMinHeight(dp(50)); return b; }
    private Button secondaryButton(String label) { Button b = new Button(this); b.setText(label); b.setTextSize(15); b.setTextColor(Color.rgb(35,75,150)); b.setBackgroundColor(Color.WHITE); b.setAllCaps(false); b.setMinHeight(dp(50)); return b; }
    private LinearLayout.LayoutParams matchWrap() { return new LinearLayout.LayoutParams(-1,-2); }
    private void spacer(int value) { View s = new View(this); s.setLayoutParams(new LinearLayout.LayoutParams(1,dp(value))); root.addView(s); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
