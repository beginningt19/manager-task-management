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
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NotificationHelper.ensureChannel(this);
        showLoading();

        SessionStore.StoredSession stored = SessionStore.load(this);
        if (stored == null) {
            showLogin();
            return;
        }

        executor.execute(() -> {
            try {
                SupabaseClient.AuthSession refreshed = new SupabaseClient().refresh(stored.email, stored.refreshToken);
                SessionStore.save(this, refreshed.email, refreshed.refreshToken);
                session = refreshed;
                FcmRegistrar.registerCurrentToken(this, refreshed);
                runOnUiThread(() -> {
                    showDashboard();
                    requestNotificationPermissionIfNeeded();
                    syncNow();
                });
            } catch (Exception error) {
                SessionStore.clear(this);
                runOnUiThread(() -> {
                    Toast.makeText(this, "Влезте отново в Yavlena Manager Notifier.", Toast.LENGTH_LONG).show();
                    showLogin();
                });
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (session != null && exactAlarmButton != null) updatePermissionStatus();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private void showLoading() {
        root = baseRoot();
        TextView loading = text("Зареждане…", 18, Color.DKGRAY);
        loading.setGravity(Gravity.CENTER);
        root.addView(loading, matchWrap());
        setContentView(wrap(root));
    }

    private void showLogin() {
        session = null;
        root = baseRoot();
        root.addView(title("Yavlena Manager Notifier"));
        root.addView(text("Нативни Android напомняния за управленските задачи. Chrome не е необходим.", 15, Color.DKGRAY));
        spacer(18);

        EditText email = input("Имейл", false);
        EditText password = input("Парола", true);
        root.addView(email, matchWrap());
        spacer(10);
        root.addView(password, matchWrap());
        spacer(16);

        Button login = primaryButton("Вход и включване на напомнянията");
        TextView loginStatus = text("", 14, Color.rgb(180, 40, 40));
        root.addView(login, matchWrap());
        spacer(8);
        root.addView(loginStatus, matchWrap());

        login.setOnClickListener(view -> {
            String emailValue = email.getText().toString().trim();
            String passwordValue = password.getText().toString();
            if (emailValue.isEmpty() || passwordValue.isEmpty()) {
                loginStatus.setText("Попълнете имейл и парола.");
                return;
            }
            login.setEnabled(false);
            loginStatus.setText("Вход…");
            executor.execute(() -> {
                try {
                    SupabaseClient.AuthSession loggedIn = new SupabaseClient().login(emailValue, passwordValue);
                    SessionStore.save(this, loggedIn.email, loggedIn.refreshToken);
                    session = loggedIn;
                    FcmRegistrar.registerCurrentToken(this, loggedIn);
                    ReminderSyncWorker.ensurePeriodic(this);
                    runOnUiThread(() -> {
                        showDashboard();
                        requestNotificationPermissionIfNeeded();
                        syncNow();
                    });
                } catch (Exception error) {
                    runOnUiThread(() -> {
                        login.setEnabled(true);
                        loginStatus.setText(error.getMessage() == null ? "Неуспешен вход." : error.getMessage());
                    });
                }
            });
        });

        setContentView(wrap(root));
    }

    private void showDashboard() {
        root = baseRoot();
        root.addView(title("Yavlena Manager Notifier"));
        root.addView(text("Включено за: " + session.email, 15, Color.DKGRAY));
        spacer(16);

        status = text("Проверка на напомнянията…", 15, Color.rgb(32, 72, 145));
        status.setPadding(dp(14), dp(14), dp(14), dp(14));
        status.setBackgroundColor(Color.rgb(236, 243, 255));
        root.addView(status, matchWrap());
        spacer(14);

        exactAlarmButton = secondaryButton("Разреши точни аларми");
        exactAlarmButton.setOnClickListener(view -> openExactAlarmSettings());
        root.addView(exactAlarmButton, matchWrap());
        spacer(10);

        Button sync = primaryButton("Синхронизирай сега");
        sync.setOnClickListener(view -> syncNow());
        root.addView(sync, matchWrap());
        spacer(10);

        Button openWeb = secondaryButton("Отвори Manager Task Management");
        openWeb.setOnClickListener(view -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(WEB_URL))));
        root.addView(openWeb, matchWrap());
        spacer(26);

        TextView explanation = text(
                "Как работи:\n\n• Новите и редактираните напомняния се изпращат веднага към телефона чрез Firebase Cloud Messaging.\n"
                        + "• Телефонът насрочва точен Android alarm за избрания час — приложението и браузърът могат да бъдат затворени.\n"
                        + "• Периодичната синхронизация през 15+ минути остава само като резервен механизъм.\n"
                        + "• След рестарт на телефона графикът се възстановява автоматично.",
                14,
                Color.DKGRAY);
        root.addView(explanation, matchWrap());
        spacer(26);

        Button logout = secondaryButton("Изход от акаунта на този телефон");
        logout.setOnClickListener(view -> {
            FcmRegistrar.unregisterCurrentToken(this, session);
            ReminderSyncWorker.cancelAll(this);
            ReminderScheduler.clear(this);
            SessionStore.clear(this);
            session = null;
            showLogin();
        });
        root.addView(logout, matchWrap());

        setContentView(wrap(root));
        ReminderSyncWorker.ensurePeriodic(this);
        updatePermissionStatus();
    }

    private void syncNow() {
        if (session == null || status == null) return;
        status.setText("Синхронизиране…");
        executor.execute(() -> {
            try {
                SessionStore.StoredSession stored = SessionStore.load(this);
                if (stored == null) throw new IllegalStateException("Липсва запазена сесия.");
                SupabaseClient.AuthSession refreshed = new SupabaseClient().refresh(stored.email, stored.refreshToken);
                SessionStore.save(this, refreshed.email, refreshed.refreshToken);
                session = refreshed;
                FcmRegistrar.registerCurrentToken(this, refreshed);
                ReminderScheduler.SyncResult result = ReminderScheduler.sync(this, refreshed);
                ReminderSyncWorker.ensurePeriodic(this);
                runOnUiThread(() -> {
                    String exactText = result.exactAlarms
                            ? "Точните аларми са разрешени."
                            : "Точните аларми НЕ са разрешени — Android може да забави известията.";
                    String pushText = FcmRegistrar.isConfigured(this)
                            ? "Моментният FCM push е конфигуриран."
                            : "Моментният FCM push още НЕ е конфигуриран — работи резервната синхронизация.";
                    status.setText("Синхронизирано. Насрочени бъдещи напомняния: " + result.scheduled
                            + ".\n" + exactText + "\n" + pushText);
                    updatePermissionStatus();
                });
            } catch (Exception error) {
                runOnUiThread(() -> status.setText("Грешка при синхронизация: "
                        + (error.getMessage() == null ? "неизвестна грешка" : error.getMessage())));
            }
        });
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private void openExactAlarmSettings() {
        if (Build.VERSION.SDK_INT < 31) return;
        AlarmManager alarmManager = getSystemService(AlarmManager.class);
        if (alarmManager.canScheduleExactAlarms()) {
            Toast.makeText(this, "Точните аларми вече са разрешени.", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }

    private void updatePermissionStatus() {
        if (exactAlarmButton == null) return;
        boolean exact = Build.VERSION.SDK_INT < 31 || getSystemService(AlarmManager.class).canScheduleExactAlarms();
        exactAlarmButton.setVisibility(exact ? View.GONE : View.VISIBLE);
        if (!exact && status != null && !status.getText().toString().contains("точни аларми")) {
            status.setText(status.getText() + "\nРазрешете „Alarms & reminders“, за да идват точно на часа.");
        }
    }

    private LinearLayout baseRoot() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(22), dp(28), dp(22), dp(32));
        layout.setBackgroundColor(Color.rgb(244, 248, 255));
        return layout;
    }

    private ScrollView wrap(View content) {
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private TextView title(String value) {
        TextView title = text(value, 26, Color.rgb(38, 94, 196));
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setPadding(0, 0, 0, dp(8));
        return title;
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.12f);
        return view;
    }

    private EditText input(String hint, boolean password) {
        EditText edit = new EditText(this);
        edit.setHint(hint);
        edit.setTextSize(16);
        edit.setSingleLine(true);
        edit.setPadding(dp(14), dp(12), dp(14), dp(12));
        edit.setBackgroundColor(Color.WHITE);
        if (password) edit.setInputType(0x00000081);
        else edit.setInputType(0x00000021);
        return edit;
    }

    private Button primaryButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(15);
        button.setTextColor(Color.WHITE);
        button.setBackgroundColor(Color.rgb(38, 94, 196));
        button.setAllCaps(false);
        button.setMinHeight(dp(50));
        return button;
    }

    private Button secondaryButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(15);
        button.setTextColor(Color.rgb(35, 75, 150));
        button.setBackgroundColor(Color.WHITE);
        button.setAllCaps(false);
        button.setMinHeight(dp(50));
        return button;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private void spacer(int dp) {
        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(1, dp(dp)));
        root.addView(spacer);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
