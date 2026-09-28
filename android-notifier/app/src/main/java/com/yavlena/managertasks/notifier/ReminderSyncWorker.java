package com.yavlena.managertasks.notifier;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

public final class ReminderSyncWorker extends Worker {
    private static final String PERIODIC_NAME = "yavlena-reminder-sync-periodic";
    private static final String IMMEDIATE_NAME = "yavlena-reminder-sync-immediate";

    public ReminderSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        DeviceSessionStore.StoredDeviceSession stored = DeviceSessionStore.load(getApplicationContext());
        if (stored == null) return Result.success();

        try {
            SupabaseClient.DeviceSession session = stored.toSession();
            FcmRegistrar.registerCurrentToken(getApplicationContext(), session);
            ReminderScheduler.sync(getApplicationContext(), session);
            return Result.success();
        } catch (Exception error) {
            // Never clear the persistent notifier session automatically.
            return Result.retry();
        }
    }

    static void ensurePeriodic(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                ReminderSyncWorker.class,
                15,
                TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                request);
    }

    static void enqueueImmediate(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(ReminderSyncWorker.class)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_NAME,
                ExistingWorkPolicy.REPLACE,
                request);
    }

    static void cancelAll(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_NAME);
        WorkManager.getInstance(context).cancelUniqueWork(IMMEDIATE_NAME);
    }
}
