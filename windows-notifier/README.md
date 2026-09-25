# Yavlena Manager Notifier (Windows)

Native browser-independent notification companion for Manager Task Management.

- Uses the same Manager Task Management account.
- Stores no password; only the rotating Supabase refresh token, encrypted with Windows DPAPI for the current Windows user.
- Starts automatically with Windows after successful login.
- Checks new assigned tasks, manager task updates, reminders, and internal messages every 20 seconds.
- Keeps the session during temporary internet/server problems and asks for login only when the refresh token is actually invalid.
- Opens task notifications directly on the exact task.
- Uses its own mutex, startup entry, and local data folder so it can coexist with the Admin notifier.
