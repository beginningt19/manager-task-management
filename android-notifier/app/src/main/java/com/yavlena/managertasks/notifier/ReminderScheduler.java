package com.yavlena.managertasks.notifier;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.*;
import android.os.Build;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

final class ReminderScheduler {
    private static final String PREFS = "yavlena_manager_notifier_schedule";
    private static final String SCHEDULED_IDS = "scheduled_ids";
    private static final String DELIVERED = "delivered";
    private static final String LAST_SYNC = "last_sync";

    static final class SyncResult {
        final int scheduled, deliveredNow; final boolean exactAlarms;
        SyncResult(int scheduled, int deliveredNow, boolean exactAlarms) {
            this.scheduled = scheduled; this.deliveredNow = deliveredNow; this.exactAlarms = exactAlarms;
        }
    }

    static SyncResult sync(Context context, SupabaseClient.AuthSession session) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Instant now = Instant.now();
        long lastSyncMillis = prefs.getLong(LAST_SYNC, 0L);
        Instant from = lastSyncMillis == 0L ? now.minus(5, ChronoUnit.MINUTES) : Instant.ofEpochMilli(lastSyncMillis).minus(2, ChronoUnit.MINUTES);
        Instant sevenDaysAgo = now.minus(7, ChronoUnit.DAYS);
        if (from.isBefore(sevenDaysAgo)) from = sevenDaysAgo;
        Instant to = now.plus(90, ChronoUnit.DAYS);

        List<SupabaseClient.Reminder> reminders = new SupabaseClient().fetchReminders(session.accessToken, from, to);
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        boolean exact = canScheduleExact(alarms);

        Set<String> previous = new HashSet<>(prefs.getStringSet(SCHEDULED_IDS, Collections.emptySet()));
        for (String id : previous) cancelAlarm(context, alarms, id);

        Set<String> scheduledNow = new HashSet<>();
        Set<String> delivered = new HashSet<>(prefs.getStringSet(DELIVERED, Collections.emptySet()));
        int immediate = 0, scheduled = 0;

        for (SupabaseClient.Reminder reminder : reminders) {
            if (reminder.completed) continue;
            String deliveryKey = reminder.id + "|" + reminder.remindAt.toEpochMilli();
            if (!reminder.remindAt.isAfter(now)) {
                if (!delivered.contains(deliveryKey)) {
                    NotificationHelper.show(context, reminder);
                    delivered.add(deliveryKey); immediate++;
                }
                continue;
            }
            scheduleAlarm(context, alarms, reminder, exact);
            scheduledNow.add(reminder.id); scheduled++;
        }

        if (delivered.size() > 1000) delivered.clear();
        prefs.edit().putStringSet(SCHEDULED_IDS, scheduledNow).putStringSet(DELIVERED, delivered).putLong(LAST_SYNC, now.toEpochMilli()).apply();
        return new SyncResult(scheduled, immediate, exact);
    }

    static void markDelivered(Context context, String reminderId, long remindAt) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> delivered = new HashSet<>(prefs.getStringSet(DELIVERED, Collections.emptySet()));
        delivered.add(reminderId + "|" + remindAt);
        Set<String> scheduled = new HashSet<>(prefs.getStringSet(SCHEDULED_IDS, Collections.emptySet()));
        scheduled.remove(reminderId);
        prefs.edit().putStringSet(DELIVERED, delivered).putStringSet(SCHEDULED_IDS, scheduled).apply();
    }

    static void clear(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        for (String id : prefs.getStringSet(SCHEDULED_IDS, Collections.emptySet())) cancelAlarm(context, alarms, id);
        prefs.edit().clear().apply();
    }

    private static void scheduleAlarm(Context context, AlarmManager alarms, SupabaseClient.Reminder reminder, boolean exact) {
        Intent intent = alarmIntent(context, reminder.id).putExtra("id", reminder.id).putExtra("task_id", reminder.taskId)
                .putExtra("remind_at", reminder.remindAt.toEpochMilli()).putExtra("description", reminder.description);
        PendingIntent pending = PendingIntent.getBroadcast(context, reminder.id.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long when = reminder.remindAt.toEpochMilli();
        if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
    }

    private static boolean canScheduleExact(AlarmManager alarms) {
        return Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms();
    }

    private static void cancelAlarm(Context context, AlarmManager alarms, String reminderId) {
        PendingIntent pending = PendingIntent.getBroadcast(context, reminderId.hashCode(), alarmIntent(context, reminderId),
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (pending != null) { alarms.cancel(pending); pending.cancel(); }
    }

    private static Intent alarmIntent(Context context, String reminderId) {
        return new Intent(context, ReminderReceiver.class).setAction(context.getPackageName() + ".REMINDER." + reminderId);
    }
}
