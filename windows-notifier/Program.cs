using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;

namespace YavlenaManagerTaskNotifier;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, "Local\\YavlenaManagerTaskNotifier", out var createdNew);
        if (!createdNew) return;

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var api = new SupabaseApi();
        AuthState? auth = null;
        var stored = SessionStore.Load();
        if (stored is not null)
        {
            try
            {
                auth = api.RefreshAsync(stored.Email, stored.RefreshToken).GetAwaiter().GetResult();
                SessionStore.Save(auth.Email, auth.RefreshToken);
            }
            catch (AuthException)
            {
                SessionStore.Clear();
            }
            catch
            {
                auth = new AuthState(stored.Email, "", stored.RefreshToken, DateTimeOffset.MinValue);
            }
        }

        if (auth is null)
        {
            using var login = new LoginForm(api);
            if (login.ShowDialog() != DialogResult.OK || login.Auth is null) return;
            auth = login.Auth;
            SessionStore.Save(auth.Email, auth.RefreshToken);
        }

        StartupRegistration.Ensure();
        var session = new AuthSessionManager(api, auth);
        Application.Run(new NotifierContext(api, session));
    }
}

internal sealed class NotifierContext : ApplicationContext
{
    private readonly SupabaseApi _api;
    private readonly AuthSessionManager _session;
    private readonly NotifyIcon _tray;
    private readonly System.Windows.Forms.Timer _timer;
    private readonly Queue<Func<Form>> _alerts = new();
    private readonly NotifierState _state;
    private bool _polling;
    private Form? _currentAlert;

    public NotifierContext(SupabaseApi api, AuthSessionManager session)
    {
        _api = api;
        _session = session;
        _state = StateStore.Load();

        var menu = new ContextMenuStrip();
        menu.Items.Add("Провери сега", null, async (_, _) => await PollAsync());
        menu.Items.Add("Смени акаунта", null, async (_, _) => await ChangeAccountAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Изход", null, (_, _) => ExitThread());

        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Information,
            Text = "Yavlena Manager Notifier",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _tray.DoubleClick += (_, _) => MessageBox.Show(
            $"Yavlena Manager Notifier работи.\n\nАкаунт: {_session.Current.Email}\nИзвестията се проверяват независимо от браузъра.",
            "Yavlena Manager Notifier",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);

        _timer = new System.Windows.Forms.Timer { Interval = 20_000 };
        _timer.Tick += async (_, _) => await PollAsync();
        _timer.Start();
        _ = PollAsync();
    }

    private async Task ChangeAccountAsync()
    {
        using var login = new LoginForm(_api);
        if (login.ShowDialog() != DialogResult.OK || login.Auth is null) return;

        await _session.ReplaceAsync(login.Auth);
        var resetPoint = DateTimeOffset.UtcNow.AddMinutes(-2);
        _state.LastCheckUtc = resetPoint;
        _state.NewTaskLastCheckUtc = resetPoint;
        _state.ManagerUpdateLastCheckUtc = resetPoint;
        _state.Seen.Clear();
        StateStore.Save(_state);
        await PollAsync();
    }

    private async Task PollAsync()
    {
        if (_polling) return;
        _polling = true;
        AuthState? authUsed = null;
        try
        {
            authUsed = await _session.GetFreshAsync();

            var now = DateTimeOffset.UtcNow;
            var sevenDaysAgo = now.AddDays(-7);

            var reminderLower = ClampLower(_state.LastCheckUtc.AddMinutes(-2), sevenDaysAgo);
            var reminders = await _api.GetDueRemindersAsync(authUsed.AccessToken, reminderLower, now);
            foreach (var reminder in reminders.OrderBy(x => x.RemindAt))
            {
                var key = $"reminder|{reminder.Id}|{reminder.RemindAt:O}";
                if (_state.Seen.ContainsKey(key)) continue;
                _state.Seen[key] = now;

                if (reminder.Task is null || reminder.Task.Status == "completed" || reminder.Task.CompletedAt is not null)
                    continue;

                _alerts.Enqueue(() => AlertForm.ForReminder(reminder));
            }

            var newTaskLower = ClampLower(_state.NewTaskLastCheckUtc.AddMinutes(-2), sevenDaysAgo);
            var newTasks = await _api.GetNewTaskNotificationsAsync(authUsed.AccessToken, newTaskLower, now);
            foreach (var notification in newTasks.OrderBy(x => x.CreatedAt))
            {
                var key = $"new-task|{notification.Id}";
                if (_state.Seen.ContainsKey(key)) continue;
                _state.Seen[key] = now;
                _alerts.Enqueue(() => AlertForm.ForNewTask(notification));
            }

            var managerUpdateLower = ClampLower(_state.ManagerUpdateLastCheckUtc.AddMinutes(-2), sevenDaysAgo);
            var managerUpdates = await _api.GetManagerTaskNotificationsAsync(authUsed.AccessToken, managerUpdateLower, now);
            foreach (var notification in managerUpdates.OrderBy(x => x.CreatedAt))
            {
                var key = $"manager-task-update|{notification.Id}";
                if (_state.Seen.ContainsKey(key)) continue;
                _state.Seen[key] = now;
                _alerts.Enqueue(() => AlertForm.ForManagerUpdate(notification));
            }

            foreach (var old in _state.Seen.Where(x => x.Value < now.AddDays(-30)).Select(x => x.Key).ToList())
                _state.Seen.Remove(old);

            _state.LastCheckUtc = now;
            _state.NewTaskLastCheckUtc = now;
            _state.ManagerUpdateLastCheckUtc = now;
            StateStore.Save(_state);
            ShowNextAlert();
        }
        catch (AuthException)
        {
            try
            {
                await _session.RecoverAfterUnauthorizedAsync(authUsed?.AccessToken);
                return;
            }
            catch (AuthException)
            {
                _timer.Stop();
                SessionStore.Clear();
                MessageBox.Show(
                    "Сесията за известия вече не може да бъде подновена. Влезте отново в Yavlena Manager Notifier.",
                    "Yavlena Manager Notifier",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                await ChangeAccountAsync();
                _timer.Start();
            }
            catch
            {
                // Temporary network/server issue while refreshing. Keep the stored session.
            }
        }
        catch
        {
            // Network problems are intentionally silent. Saved timestamps make the next poll retry
            // the missed interval instead of losing notifications while the PC is offline.
        }
        finally
        {
            _polling = false;
        }
    }

    private static DateTimeOffset ClampLower(DateTimeOffset candidate, DateTimeOffset minimum) =>
        candidate < minimum ? minimum : candidate;

    private void ShowNextAlert()
    {
        if (_currentAlert is not null || _alerts.Count == 0) return;
        _currentAlert = _alerts.Dequeue().Invoke();
        _currentAlert.FormClosed += (_, _) =>
        {
            _currentAlert.Dispose();
            _currentAlert = null;
            ShowNextAlert();
        };
        _currentAlert.Show();
        _currentAlert.Activate();
        _currentAlert.BringToFront();
    }

    protected override void ExitThreadCore()
    {
        _timer.Stop();
        _tray.Visible = false;
        _tray.Dispose();
        _currentAlert?.Close();
        base.ExitThreadCore();
    }
}

internal sealed class LoginForm : Form
{
    private readonly SupabaseApi _api;
    private readonly TextBox _email = new();
    private readonly TextBox _password = new();
    private readonly Button _login = new();
    private readonly Label _status = new();

    public AuthState? Auth { get; private set; }

    public LoginForm(SupabaseApi api)
    {
        _api = api;
        Text = "Yavlena Manager Notifier";
        Width = 430;
        Height = 305;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        Font = new Font("Segoe UI", 10F);

        var title = new Label
        {
            Text = "Известия за управленски задачи",
            Font = new Font("Segoe UI Semibold", 15F),
            AutoSize = true,
            Left = 28,
            Top = 24,
        };
        var subtitle = new Label
        {
            Text = "Влезте със същия Yavlena акаунт. Паролата не се запазва.",
            AutoSize = true,
            ForeColor = Color.DimGray,
            Left = 28,
            Top = 60,
        };
        var emailLabel = new Label { Text = "Имейл", AutoSize = true, Left = 28, Top = 96 };
        _email.SetBounds(28, 118, 360, 30);
        _email.PlaceholderText = "name@yavlena.com";
        var passLabel = new Label { Text = "Парола", AutoSize = true, Left = 28, Top = 154 };
        _password.SetBounds(28, 176, 360, 30);
        _password.UseSystemPasswordChar = true;
        _login.Text = "Вход и включване на известията";
        _login.SetBounds(28, 216, 250, 34);
        _login.Click += async (_, _) => await LoginAsync();
        _status.SetBounds(286, 216, 102, 40);
        _status.ForeColor = Color.Firebrick;
        _status.TextAlign = ContentAlignment.MiddleLeft;

        Controls.AddRange([title, subtitle, emailLabel, _email, passLabel, _password, _login, _status]);
        AcceptButton = _login;
    }

    private async Task LoginAsync()
    {
        if (string.IsNullOrWhiteSpace(_email.Text) || string.IsNullOrEmpty(_password.Text)) return;
        _login.Enabled = false;
        _status.Text = "Вход…";
        try
        {
            Auth = await _api.LoginAsync(_email.Text.Trim(), _password.Text);
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception ex)
        {
            _status.Text = "Грешка";
            MessageBox.Show(ex.Message, "Неуспешен вход", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _login.Enabled = true;
        }
    }
}

internal sealed class AlertForm : Form
{
    private AlertForm(string windowTitle, string headerText, string subtitleText, string bodyText, Color headerColor, string? taskId)
    {
        Text = windowTitle;
        Width = 580;
        Height = 315;
        TopMost = true;
        ShowInTaskbar = true;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        Font = new Font("Segoe UI", 10F);
        BackColor = Color.White;
        StartPosition = FormStartPosition.Manual;

        var header = new Panel { Dock = DockStyle.Top, Height = 64, BackColor = headerColor };
        header.Controls.Add(new Label
        {
            Text = headerText,
            ForeColor = Color.White,
            Font = new Font("Segoe UI Semibold", 13.5F),
            AutoSize = true,
            MaximumSize = new Size(535, 0),
            Left = 20,
            Top = 17,
        });

        var subtitle = new Label
        {
            Text = subtitleText,
            ForeColor = Color.DimGray,
            AutoSize = true,
            MaximumSize = new Size(530, 34),
            Left = 22,
            Top = 82,
        };

        var body = new TextBox
        {
            Text = bodyText,
            ReadOnly = true,
            Multiline = true,
            BorderStyle = BorderStyle.None,
            BackColor = Color.White,
            Font = new Font("Segoe UI Semibold", 11.5F),
            Left = 22,
            Top = 112,
            Width = 530,
            Height = 105,
            ScrollBars = ScrollBars.Vertical,
            TabStop = false,
        };

        var open = new Button
        {
            Text = "Отвори задачите",
            Left = 22,
            Top = 235,
            Width = 180,
            Height = 38,
            BackColor = Color.FromArgb(38, 94, 196),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
        };
        open.FlatAppearance.BorderSize = 0;
        open.Click += (_, _) =>
        {
            var target = "https://manager-task-management.pages.dev/";
            if (!string.IsNullOrWhiteSpace(taskId))
                target += "?task=" + Uri.EscapeDataString(taskId);
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            Close();
        };

        var dismiss = new Button { Text = "Разбрах", Left = 432, Top = 235, Width = 120, Height = 38 };
        dismiss.Click += (_, _) => Close();

        Controls.AddRange([header, subtitle, body, open, dismiss]);
        Shown += (_, _) => PositionAndFlash();
    }

    public static AlertForm ForReminder(DueReminder reminder) => new(
        "Напомняне за задача",
        "⏰  НАПОМНЯНЕ ЗА ЗАДАЧА",
        $"Зададено за {reminder.RemindAt.ToLocalTime():dd.MM.yyyy HH:mm}",
        reminder.Task?.Description ?? "Задача",
        Color.FromArgb(38, 94, 196),
        reminder.TaskId);

    public static AlertForm ForNewTask(NewTaskNotification notification) => new(
        $"Нова задача от {notification.CreatorName}",
        $"🔔  НОВА ЗАДАЧА ОТ {notification.CreatorName.ToUpperInvariant()}",
        $"Възложена на {notification.CreatedAt.ToLocalTime():dd.MM.yyyy HH:mm}",
        notification.TaskDescription,
        Color.FromArgb(38, 94, 196),
        notification.TaskId);

    public static AlertForm ForManagerUpdate(ManagerTaskNotification notification)
    {
        var completed = notification.EventType == "completed";
        var status = notification.EventType == "status";
        var header = completed
            ? "✅  ЗАДАЧАТА Е ИЗПЪЛНЕНА"
            : status
                ? "↻  ПРОМЯНА ПО ЗАДАЧА"
                : "↻  РАЗВИТИЕ ПО ЗАДАЧА";
        var title = completed ? "Задачата е изпълнена" : "Развитие по задача";
        var body = $"{notification.TaskDescription}\r\n\r\n{notification.Message}";
        var color = completed ? Color.FromArgb(30, 135, 92) : Color.FromArgb(53, 119, 173);
        return new AlertForm(
            title,
            header,
            $"{notification.ActorName} • {notification.CreatedAt.ToLocalTime():dd.MM.yyyy HH:mm}",
            body,
            color,
            notification.TaskId);
    }

    private void PositionAndFlash()
    {
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Right - Width - 18, area.Bottom - Height - 18);
        Activate();
        BringToFront();
        NativeAttention.Flash(Handle);
    }
}

internal sealed class SupabaseApi
{
    private const string BaseUrl = "https://xrcvfzqwhqtoljfxgxgr.supabase.co";
    private const string PublishableKey = "sb_publishable_K9eOz-sxjizM7fkHrWXOeA_zu-9ijLu";
    private readonly HttpClient _http = new() { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromSeconds(20) };

    public SupabaseApi() => _http.DefaultRequestHeaders.Add("apikey", PublishableKey);

    public Task<AuthState> LoginAsync(string email, string password) => AuthenticateAsync(
        "/auth/v1/token?grant_type=password",
        new { email, password },
        email);

    public Task<AuthState> RefreshAsync(string email, string refreshToken) => AuthenticateAsync(
        "/auth/v1/token?grant_type=refresh_token",
        new { refresh_token = refreshToken },
        email);

    public async Task<AuthState> EnsureFreshAsync(AuthState current)
    {
        if (current.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2)) return current;
        try
        {
            return await RefreshAsync(current.Email, current.RefreshToken);
        }
        catch (Exception ex)
        {
            throw new AuthException(ex.Message, ex);
        }
    }

    private async Task<AuthState> AuthenticateAsync(string path, object payload, string email)
    {
        using var response = await _http.PostAsJsonAsync(path, payload);
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            if ((int)response.StatusCode >= 500 || response.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
                throw new HttpRequestException($"Supabase Auth временно не е достъпен ({(int)response.StatusCode}).");

            string message = "Невалиден имейл или парола.";
            try
            {
                using var errorJson = JsonDocument.Parse(text);
                message = errorJson.RootElement.TryGetProperty("error_description", out var description)
                    ? description.GetString() ?? message
                    : errorJson.RootElement.TryGetProperty("msg", out var msg)
                        ? msg.GetString() ?? message
                        : message;
            }
            catch { }
            throw new AuthException(message);
        }

        using var json = JsonDocument.Parse(text);
        var root = json.RootElement;
        var accessToken = root.GetProperty("access_token").GetString() ?? throw new AuthException("Липсва access token.");
        var refreshToken = root.GetProperty("refresh_token").GetString() ?? throw new AuthException("Липсва refresh token.");
        var expiresIn = root.TryGetProperty("expires_in", out var expires) ? expires.GetInt32() : 3600;
        return new AuthState(email, accessToken, refreshToken, DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, expiresIn - 30)));
    }

    public async Task<List<DueReminder>> GetDueRemindersAsync(string accessToken, DateTimeOffset from, DateTimeOffset to)
    {
        var select = Uri.EscapeDataString("id,task_id,remind_at,tasks(description,status,completed_at)");
        var result = await GetListAsync<DueReminder>(
            $"/rest/v1/task_reminders?select={select}&remind_at=gte.{Encode(from)}&remind_at=lte.{Encode(to)}&order=remind_at.asc",
            accessToken);
        return result;
    }

    public Task<List<NewTaskNotification>> GetNewTaskNotificationsAsync(string accessToken, DateTimeOffset from, DateTimeOffset to)
    {
        var select = Uri.EscapeDataString("id,task_id,creator_name,task_description,created_at");
        return GetListAsync<NewTaskNotification>(
            $"/rest/v1/task_assignment_notifications?select={select}&created_at=gte.{Encode(from)}&created_at=lte.{Encode(to)}&order=created_at.asc",
            accessToken);
    }

    public Task<List<ManagerTaskNotification>> GetManagerTaskNotificationsAsync(string accessToken, DateTimeOffset from, DateTimeOffset to)
    {
        var select = Uri.EscapeDataString("id,task_id,actor_name,event_type,task_description,message,created_at");
        return GetListAsync<ManagerTaskNotification>(
            $"/rest/v1/task_manager_notifications?select={select}&created_at=gte.{Encode(from)}&created_at=lte.{Encode(to)}&order=created_at.asc",
            accessToken);
    }

    private async Task<List<T>> GetListAsync<T>(string path, string accessToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var response = await _http.SendAsync(request);
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            throw new AuthException("Access token-ът е невалиден или е изтекъл.");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<List<T>>(JsonOptions.Default) ?? [];
    }

    private static string Encode(DateTimeOffset value) => Uri.EscapeDataString(value.ToString("O"));
}

internal sealed class AuthSessionManager
{
    private readonly SupabaseApi _api;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private AuthState _current;

    public AuthSessionManager(SupabaseApi api, AuthState initial)
    {
        _api = api;
        _current = initial;
        SessionStore.Save(initial.Email, initial.RefreshToken);
    }

    public AuthState Current => _current;

    public async Task<AuthState> GetFreshAsync()
    {
        await _refreshGate.WaitAsync();
        try
        {
            if (_current.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2))
                return _current;

            _current = await _api.RefreshAsync(_current.Email, _current.RefreshToken);
            SessionStore.Save(_current.Email, _current.RefreshToken);
            return _current;
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    public async Task<AuthState> RecoverAfterUnauthorizedAsync(string? failedAccessToken)
    {
        await _refreshGate.WaitAsync();
        try
        {
            if (!string.IsNullOrWhiteSpace(failedAccessToken)
                && !string.Equals(_current.AccessToken, failedAccessToken, StringComparison.Ordinal))
                return _current;

            _current = await _api.RefreshAsync(_current.Email, _current.RefreshToken);
            SessionStore.Save(_current.Email, _current.RefreshToken);
            return _current;
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    public async Task ReplaceAsync(AuthState next)
    {
        await _refreshGate.WaitAsync();
        try
        {
            _current = next;
            SessionStore.Save(next.Email, next.RefreshToken);
        }
        finally
        {
            _refreshGate.Release();
        }
    }
}

internal static class StartupRegistration
{
    public static void Ensure()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", writable: true);
            key?.SetValue("YavlenaManagerTaskNotifier", $"\"{Application.ExecutablePath}\" --background");
        }
        catch { }
    }
}

internal static class SessionStore
{
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YavlenaManagerTaskNotifier");
    private static readonly string FilePath = Path.Combine(Folder, "session.bin");

    public static void Save(string email, string refreshToken)
    {
        Directory.CreateDirectory(Folder);
        var plain = JsonSerializer.SerializeToUtf8Bytes(new StoredSession(email, refreshToken));
        File.WriteAllBytes(FilePath, DataProtection.Protect(plain));
    }

    public static StoredSession? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var plain = DataProtection.Unprotect(File.ReadAllBytes(FilePath));
            return JsonSerializer.Deserialize<StoredSession>(plain);
        }
        catch
        {
            Clear();
            return null;
        }
    }

    public static void Clear()
    {
        try { if (File.Exists(FilePath)) File.Delete(FilePath); } catch { }
    }
}

internal static class StateStore
{
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YavlenaManagerTaskNotifier");
    private static readonly string FilePath = Path.Combine(Folder, "state.json");

    public static NotifierState Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new NotifierState();
            return JsonSerializer.Deserialize<NotifierState>(File.ReadAllText(FilePath)) ?? new NotifierState();
        }
        catch { return new NotifierState(); }
    }

    public static void Save(NotifierState state)
    {
        try
        {
            Directory.CreateDirectory(Folder);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(state));
        }
        catch { }
    }
}

internal static class DataProtection
{
    private const int CryptProtectUiForbidden = 0x1;

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob { public int Size; public IntPtr Data; }

    [DllImport("Crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CryptProtectData(ref DataBlob input, string? description, IntPtr optionalEntropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("Crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CryptUnprotectData(ref DataBlob input, out IntPtr description, IntPtr optionalEntropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("Kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static byte[] Protect(byte[] input) => Transform(input, true);
    public static byte[] Unprotect(byte[] input) => Transform(input, false);

    private static byte[] Transform(byte[] input, bool protect)
    {
        var inputPtr = Marshal.AllocHGlobal(input.Length);
        Marshal.Copy(input, 0, inputPtr, input.Length);
        var inputBlob = new DataBlob { Size = input.Length, Data = inputPtr };
        DataBlob outputBlob;
        IntPtr description = IntPtr.Zero;
        try
        {
            var ok = protect
                ? CryptProtectData(ref inputBlob, "Yavlena Manager Notifier", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out outputBlob)
                : CryptUnprotectData(ref inputBlob, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out outputBlob);
            if (!ok) throw new InvalidOperationException($"Windows DPAPI error: {Marshal.GetLastWin32Error()}");
            try
            {
                var output = new byte[outputBlob.Size];
                Marshal.Copy(outputBlob.Data, output, 0, output.Length);
                return output;
            }
            finally { LocalFree(outputBlob.Data); }
        }
        finally
        {
            if (description != IntPtr.Zero) LocalFree(description);
            Marshal.FreeHGlobal(inputPtr);
        }
    }
}

internal static class NativeAttention
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public uint Size;
        public IntPtr Hwnd;
        public uint Flags;
        public uint Count;
        public uint Timeout;
    }

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FlashInfo info);

    public static void Flash(IntPtr hwnd)
    {
        var info = new FlashInfo
        {
            Size = (uint)Marshal.SizeOf<FlashInfo>(),
            Hwnd = hwnd,
            Flags = 0x00000003 | 0x0000000C,
            Count = 5,
            Timeout = 0,
        };
        FlashWindowEx(ref info);
    }
}

internal sealed record AuthState(string Email, string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt);
internal sealed record StoredSession(string Email, string RefreshToken);

internal sealed class NotifierState
{
    public DateTimeOffset LastCheckUtc { get; set; } = DateTimeOffset.UtcNow.AddMinutes(-2);
    public DateTimeOffset NewTaskLastCheckUtc { get; set; } = DateTimeOffset.UtcNow.AddMinutes(-2);
    public DateTimeOffset ManagerUpdateLastCheckUtc { get; set; } = DateTimeOffset.UtcNow.AddMinutes(-2);
    public Dictionary<string, DateTimeOffset> Seen { get; set; } = new();
}

internal sealed class DueReminder
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("task_id")] public string TaskId { get; set; } = "";
    [JsonPropertyName("remind_at")] public DateTimeOffset RemindAt { get; set; }
    [JsonPropertyName("tasks")] public ReminderTask? Task { get; set; }
}

internal sealed class ReminderTask
{
    [JsonPropertyName("description")] public string Description { get; set; } = "";
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("completed_at")] public DateTimeOffset? CompletedAt { get; set; }
}

internal sealed class NewTaskNotification
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("task_id")] public string TaskId { get; set; } = "";
    [JsonPropertyName("creator_name")] public string CreatorName { get; set; } = "Управител";
    [JsonPropertyName("task_description")] public string TaskDescription { get; set; } = "Задача";
    [JsonPropertyName("created_at")] public DateTimeOffset CreatedAt { get; set; }
}

internal sealed class ManagerTaskNotification
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("task_id")] public string TaskId { get; set; } = "";
    [JsonPropertyName("actor_name")] public string ActorName { get; set; } = "Изпълнител";
    [JsonPropertyName("event_type")] public string EventType { get; set; } = "progress";
    [JsonPropertyName("task_description")] public string TaskDescription { get; set; } = "Задача";
    [JsonPropertyName("message")] public string Message { get; set; } = "Има промяна по задачата.";
    [JsonPropertyName("created_at")] public DateTimeOffset CreatedAt { get; set; }
}

internal sealed class AuthException : Exception
{
    public AuthException(string message) : base(message) { }
    public AuthException(string message, Exception inner) : base(message, inner) { }
}

internal static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };
}
