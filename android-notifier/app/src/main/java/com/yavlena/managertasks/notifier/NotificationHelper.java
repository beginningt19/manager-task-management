package com.yavlena.managertasks.notifier;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

final class NotificationHelper {
    static final String CHANNEL_ID = "manager_task_reminders_v1";
    private static final String WEB_URL = "https://manager-task-management.pages.dev/";

    static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                context.getString(R.string.notification_channel_name), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.notification_channel_description));
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0,250,120,250,120,450});
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    static void show(Context context, SupabaseClient.Reminder reminder) {
        ensureChannel(context);
        if (!canNotify(context)) return;
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(WEB_URL));
        PendingIntent contentIntent = PendingIntent.getActivity(context, reminder.id.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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
        context.getSystemService(NotificationManager.class).notify(reminder.id.hashCode(), notification);
    }

    private static boolean canNotify(Context context) {
        return Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }
}
