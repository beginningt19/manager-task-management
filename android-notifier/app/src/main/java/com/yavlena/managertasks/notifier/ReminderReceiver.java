package com.yavlena.managertasks.notifier;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.time.Instant;

public final class ReminderReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        if (id == null) return;
        String taskId = intent.getStringExtra("task_id");
        String description = intent.getStringExtra("description");
        long remindAt = intent.getLongExtra("remind_at", System.currentTimeMillis());
        SupabaseClient.Reminder reminder = new SupabaseClient.Reminder(
                id,
                taskId == null ? "" : taskId,
                Instant.ofEpochMilli(remindAt),
                description == null || description.trim().isEmpty() ? "Задача" : description,
                false);
        NotificationHelper.show(context, reminder);
        ReminderScheduler.markDelivered(context, id, remindAt);
    }
}
