package com.yavlena.managertasks.notifier;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

final class NotificationHelper {
    static final String CHANNEL_ID = "manager_task_reminders_v1";
    private static final String WEB_URL = "https://manager-task-management.pages.dev/";

    static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel != null) return;

        channel = new NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.notification_channel_description));
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 250, 120, 250, 120, 450});
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    static void show(Context context, SupabaseClient.Reminder reminder) {
        ensureChannel(context);
        if (!canNotify(context)) return;

        PendingIntent contentIntent = openTasksIntent(context, reminder.id.hashCode());
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("⏰ Напомняне за задача")
                .setContentText(reminder.description)
                .setStyle(new Notification.BigTextStyle().bigText(reminder.description))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setWhen(reminder.remindAt.toEpochMilli())
                .setShowWhen(true)
                .build();

        context.getSystemService(NotificationManager.class)
                .notify(reminder.id.hashCode(), notification);
    }

    static void showInternalMessage(Context context, String notificationId, String senderName, String subject, String body) {
        ensureChannel(context);
        if (!canNotify(context)) return;

        String safeSender = safeText(senderName, "Колега");
        String safeSubject = subject == null ? "" : subject.trim();
        String safeBody = safeText(body, "Ново съобщение");
        String expanded = safeSubject.isEmpty() ? safeBody : safeSubject + "\n" + safeBody;

        int notificationCode = ("internal-message|" + notificationId).hashCode();
        PendingIntent contentIntent = openTasksIntent(context, notificationCode);
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("✉ Ново съобщение от " + safeSender)
                .setContentText(safeSubject.isEmpty() ? safeBody : safeSubject)
                .setStyle(new Notification.BigTextStyle().bigText(expanded))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .build();

        context.getSystemService(NotificationManager.class)
                .notify(notificationCode, notification);
    }

    static void showNewTask(Context context, String notificationId, String creatorName, String description) {
        ensureChannel(context);
        if (!canNotify(context)) return;

        String safeCreator = safeText(creatorName, "Управител");
        String safeDescription = safeText(description, "Задача");

        int notificationCode = ("new-task|" + notificationId).hashCode();
        PendingIntent contentIntent = openTasksIntent(context, notificationCode);
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Нова задача от " + safeCreator)
                .setContentText(safeDescription)
                .setStyle(new Notification.BigTextStyle().bigText(safeDescription))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .build();

        context.getSystemService(NotificationManager.class)
                .notify(notificationCode, notification);
    }

    static void showManagerTaskUpdate(
            Context context,
            String notificationId,
            String eventType,
            String actorName,
            String description,
            String detail) {
        ensureChannel(context);
        if (!canNotify(context)) return;

        String safeActor = safeText(actorName, "Изпълнител");
        String safeDescription = safeText(description, "Задача");
        String safeDetail = safeText(detail, "Има промяна по задачата.");

        String title;
        if ("completed".equals(eventType)) {
            title = "✅ Задачата е изпълнена от " + safeActor;
        } else if ("status".equals(eventType)) {
            title = "Промяна по задача от " + safeActor;
        } else {
            title = "Развитие по задача от " + safeActor;
        }

        String notificationBody = safeDescription + "\n" + safeDetail;
        int notificationCode = ("manager-task-update|" + notificationId).hashCode();
        PendingIntent contentIntent = openTasksIntent(context, notificationCode);
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(safeDescription)
                .setStyle(new Notification.BigTextStyle().bigText(notificationBody))
                .setCategory("completed".equals(eventType) ? Notification.CATEGORY_STATUS : Notification.CATEGORY_MESSAGE)
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .build();

        context.getSystemService(NotificationManager.class)
                .notify(notificationCode, notification);
    }

    private static String safeText(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private static boolean canNotify(Context context) {
        return Build.VERSION.SDK_INT < 33
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static PendingIntent openTasksIntent(Context context, int requestCode) {
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(WEB_URL));
        return PendingIntent.getActivity(
                context,
                requestCode,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private NotificationHelper() {}
}
