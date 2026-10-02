import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.56.1";
import webpush from "npm:web-push@3.6.7";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function getNamedKey(envName: string, legacyName: string): string {
  const modern = Deno.env.get(envName);
  if (modern) {
    const parsed = JSON.parse(modern) as Record<string, string>;
    if (parsed.default) return parsed.default;
  }
  const legacy = Deno.env.get(legacyName);
  if (!legacy) throw new Error(`Missing ${envName}`);
  return legacy;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const secretKey = getNamedKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const suppliedToken = req.headers.get("x-reminder-token");
    const { data: tokenRows, error: tokenError } = await admin
      .from("internal_dispatch_tokens")
      .select("name,token")
      .in("name", ["task-reminder-dispatch", "vapid-subject", "vapid-public-key", "vapid-private-key"]);
    if (tokenError) throw tokenError;

    const tokens = Object.fromEntries((tokenRows ?? []).map((row) => [row.name, row.token]));
    if (!tokens["task-reminder-dispatch"] || !suppliedToken || suppliedToken !== tokens["task-reminder-dispatch"]) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!tokens["vapid-subject"] || !tokens["vapid-public-key"] || !tokens["vapid-private-key"]) {
      return json({ error: "Push service is not configured" }, 503);
    }
    webpush.setVapidDetails(
      tokens["vapid-subject"],
      tokens["vapid-public-key"],
      tokens["vapid-private-key"],
    );

    const now = new Date();
    const staleBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

    await admin
      .from("task_reminders")
      .update({ processing_at: null })
      .is("sent_at", null)
      .lt("processing_at", staleBefore);

    const { data: reminders, error: remindersError } = await admin
      .from("task_reminders")
      .select("id,task_id,notebook_entry_id,created_by,remind_at")
      .is("sent_at", null)
      .is("processing_at", null)
      .lte("remind_at", now.toISOString())
      .order("remind_at", { ascending: true })
      .limit(50);
    if (remindersError) throw remindersError;

    let processed = 0;
    let delivered = 0;
    let skipped = 0;

    for (const reminder of reminders ?? []) {
      const claimedAt = new Date().toISOString();
      const { data: claim } = await admin
        .from("task_reminders")
        .update({ processing_at: claimedAt, last_error: null })
        .eq("id", reminder.id)
        .is("sent_at", null)
        .is("processing_at", null)
        .select("id")
        .maybeSingle();

      if (!claim) continue;

      try {
        let userIds: string[] = [];
        let payload: string;

        if (reminder.task_id) {
          const { data: task, error: taskError } = await admin
            .from("tasks")
            .select("id,description,created_by,completed_at,status")
            .eq("id", reminder.task_id)
            .single();

          if (taskError || !task) throw taskError || new Error("Task not found");

          if (task.completed_at || task.status === "completed") {
            await admin
              .from("task_reminders")
              .update({
                sent_at: new Date().toISOString(),
                processing_at: null,
                delivery_count: 0,
                last_error: "Skipped because task is already completed",
              })
              .eq("id", reminder.id);
            processed++;
            skipped++;
            continue;
          }

          const { data: assignments, error: assignmentsError } = await admin
            .from("task_assignees")
            .select("user_id")
            .eq("task_id", task.id);
          if (assignmentsError) throw assignmentsError;

          userIds = [...new Set((assignments ?? []).map((row) => row.user_id).filter(Boolean))];
          if (userIds.length === 0 && task.created_by) userIds.push(task.created_by);

          payload = JSON.stringify({
            type: "task-reminder",
            urgent: true,
            title: "⏰ ВАЖНО • Напомняне за задача",
            body: `${task.description.slice(0, 430)}\nНатисни, за да отвориш задачата.`,
            url: `/?task=${encodeURIComponent(task.id)}`,
            taskId: task.id,
            tag: `task-reminder-${task.id}`,
          });
        } else if (reminder.notebook_entry_id) {
          const { data: entry, error: entryError } = await admin
            .from("notebook_entries")
            .select("id,user_id,body,completed")
            .eq("id", reminder.notebook_entry_id)
            .single();

          if (entryError || !entry) throw entryError || new Error("Notebook entry not found");

          if (entry.completed) {
            await admin
              .from("task_reminders")
              .update({
                sent_at: new Date().toISOString(),
                processing_at: null,
                delivery_count: 0,
                last_error: "Skipped because notebook entry is already completed",
              })
              .eq("id", reminder.id);
            processed++;
            skipped++;
            continue;
          }

          userIds = [entry.user_id || reminder.created_by].filter(Boolean);

          payload = JSON.stringify({
            type: "notebook-reminder",
            urgent: true,
            title: "⏰ ВАЖНО • Напомняне от тефтера",
            body: `${(entry.body || "Запис от тефтера").slice(0, 430)}\nНатисни, за да отвориш системата.`,
            url: "/",
            notebookEntryId: entry.id,
            tag: `notebook-reminder-${entry.id}`,
          });
        } else {
          throw new Error("Reminder has no task_id or notebook_entry_id");
        }

        if (userIds.length === 0) {
          throw new Error("Reminder has no recipient");
        }

        const { data: subscriptions, error: subscriptionsError } = await admin
          .from("push_subscriptions")
          .select("id,endpoint,p256dh,auth")
          .in("user_id", userIds);
        if (subscriptionsError) throw subscriptionsError;

        const outcomes = await Promise.all((subscriptions ?? []).map(async (subscription) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              payload,
              { TTL: 86400, urgency: "high" },
            );
            return { id: subscription.id, sent: true, stale: false };
          } catch (error) {
            const statusCode = (error as { statusCode?: number }).statusCode;
            return { id: subscription.id, sent: false, stale: statusCode === 404 || statusCode === 410 };
          }
        }));

        const staleIds = outcomes.filter((x) => x.stale).map((x) => x.id);
        if (staleIds.length) {
          await admin.from("push_subscriptions").delete().in("id", staleIds);
        }

        const sentCount = outcomes.filter((x) => x.sent).length;
        const failedCount = outcomes.filter((x) => !x.sent && !x.stale).length;

        await admin
          .from("task_reminders")
          .update({
            sent_at: new Date().toISOString(),
            processing_at: null,
            delivery_count: sentCount,
            last_error: (subscriptions ?? []).length === 0
              ? "No enabled push subscriptions for reminder recipient"
              : failedCount > 0
                ? `${failedCount} push deliveries failed`
                : null,
          })
          .eq("id", reminder.id);

        processed++;
        delivered += sentCount;
      } catch (error) {
        console.error("Reminder dispatch failed", reminder.id, error);
        await admin
          .from("task_reminders")
          .update({
            processing_at: null,
            last_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown dispatch error",
          })
          .eq("id", reminder.id);
      }
    }

    return json({ processed, delivered, skipped, due: (reminders ?? []).length });
  } catch (error) {
    console.error(error);
    return json({ error: "Internal server error" }, 500);
  }
});
