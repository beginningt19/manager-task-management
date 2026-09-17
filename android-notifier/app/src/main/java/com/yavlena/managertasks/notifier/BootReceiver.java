package com.yavlena.managertasks.notifier;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (SessionStore.load(context) == null) return;
        ReminderSyncWorker.ensurePeriodic(context);
        ReminderSyncWorker.enqueueImmediate(context);
    }
}
