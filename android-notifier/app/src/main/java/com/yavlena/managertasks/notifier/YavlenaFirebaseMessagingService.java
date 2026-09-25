package com.yavlena.managertasks.notifier;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.time.Instant;
import java.util.Map;

public final class YavlenaFirebaseMessagingService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        FcmRegistrar.registerTokenFromStoredSession(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String type = data.get("type");

        if ("internal-message".equals(type)) {
            String notificationId = data.get("notification_id");
            if (notificationId == null || notificationId.trim().isEmpty()) return;
            NotificationHelper.showInternalMessage(
                    this,
                    notificationId,
                    data.get("sender_name"),
                    data.get("subject"),
                    data.get("body"));
            return;
        }

        if ("new-task".equals(type)) {
            String notificationId = data.get("notification_id");
            if (notificationId == null || notificationId.trim().isEmpty()) return;
            NotificationHelper.showNewTask(
                    this,
                    notificationId,
                    data.get("task_id"),
                    data.get("creator_name"),
                    data.get("description"));
            return;
        }

        if ("manager-task-update".equals(type)) {
            String notificationId = data.get("notification_id");
            if (notificationId == null || notificationId.trim().isEmpty()) return;
            NotificationHelper.showManagerTaskUpdate(
                    this,
                    notificationId,
                    data.get("task_id"),
                    data.get("event_type"),
                    data.get("actor_name"),
                    data.get("description"),
                    data.get("detail"));
            return;
        }

        if (!"task-reminder-sync".equals(type)) return;

        String reminderId = data.get("reminder_id");
        if (reminderId == null || reminderId.trim().isEmpty()) return;

        String action = data.get("action");
        if ("delete".equals(action)) {
            ReminderScheduler.applyPushDelete(this, reminderId);
            ReminderSyncWorker.enqueueImmediate(this);
            return;
        }

        try {
            String remindAtRaw = data.get("remind_at");
            if (remindAtRaw == null || remindAtRaw.trim().isEmpty()) return;
            String taskId = data.get("task_id");
            String description = data.get("description");
            SupabaseClient.Reminder reminder = new SupabaseClient.Reminder(
                    reminderId,
                    taskId == null ? "" : taskId,
                    Instant.parse(remindAtRaw),
                    description == null || description.trim().isEmpty() ? "Задача" : description,
                    false);
            ReminderScheduler.applyPushUpsert(this, reminder);
            ReminderSyncWorker.enqueueImmediate(this);
        } catch (Exception ignored) {
            ReminderSyncWorker.enqueueImmediate(this);
        }
    }
}
