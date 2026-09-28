using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace YavlenaManagerTaskNotifier;

internal static class MessageEnabledProgram
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
        var deviceSession = DeviceSessionBootstrap.LoadOrLogin(api);
        if (deviceSession is null) return;

        StartupRegistration.Ensure();
        var session = new DeviceSessionManager(deviceSession);
        using var messageNotifier = new InternalMessagePoller(api, session);
        Application.Run(new NotifierContext(api, session));
    }
}

internal sealed class InternalMessagePoller : IDisposable
{
    private readonly SupabaseApi _api;
    private readonly DeviceSessionManager _session;
    private readonly System.Windows.Forms.Timer _timer;
    private readonly Queue<WindowsInternalMessage> _queue = new();
    private InternalMessageState _state;
    private bool _polling;
    private InternalMessageForm? _current;

    public InternalMessagePoller(SupabaseApi api, DeviceSessionManager session)
    {
        _api = api;
        _session = session;
        _state = InternalMessageStateStore.Load();
        _timer = new System.Windows.Forms.Timer { Interval = 20_000 };
        _timer.Tick += async (_, _) => await PollAsync();
        _timer.Start();
        _ = PollAsync();
    }

    private async Task PollAsync()
    {
        if (_polling) return;
        _polling = true;
        try
        {
            var deviceToken = _session.Current.DeviceToken;

            var now = DateTimeOffset.UtcNow;
            var lower = _state.LastCheckUtc.AddMinutes(-2);
            var sevenDaysAgo = now.AddDays(-7);
            if (lower < sevenDaysAgo) lower = sevenDaysAgo;

            var rows = await _api.GetInternalMessagesAsync(deviceToken, lower, now);
            foreach (var row in rows.OrderBy(x => x.CreatedAt))
            {
                if (string.IsNullOrWhiteSpace(row.MessageId) || row.Message is null) continue;
                var key = $"internal-message|{row.MessageId}";
                if (_state.Seen.ContainsKey(key)) continue;
                _state.Seen[key] = now;
                _queue.Enqueue(row);
            }

            foreach (var old in _state.Seen.Where(x => x.Value < now.AddDays(-30)).Select(x => x.Key).ToList())
                _state.Seen.Remove(old);

            _state.LastCheckUtc = now;
            InternalMessageStateStore.Save(_state);
            ShowNext();
        }
        catch
        {
            // Never clear or replace the persistent device session automatically.
            // Retry on the next poll after network/server problems.
        }
        finally
        {
            _polling = false;
        }
    }


    private void ShowNext()
    {
        if (_current is not null || _queue.Count == 0) return;
        _current = new InternalMessageForm(_queue.Dequeue());
        _current.FormClosed += (_, _) =>
        {
            _current.Dispose();
            _current = null;
            ShowNext();
        };
        _current.Show();
        _current.Activate();
        _current.BringToFront();
    }

    public void Dispose()
    {
        _timer.Stop();
        _timer.Dispose();
        _current?.Close();
    }
}

internal sealed class InternalMessageForm : Form
{
    private readonly WindowsInternalMessage _message;

    public InternalMessageForm(WindowsInternalMessage message)
    {
        _message = message;
        var sender = string.IsNullOrWhiteSpace(message.Message?.SenderName) ? "Колега" : message.Message.SenderName.Trim();
        var subject = string.IsNullOrWhiteSpace(message.Message?.Subject) ? "(без тема)" : message.Message.Subject!.Trim();
        var bodyText = string.IsNullOrWhiteSpace(message.Message?.Body) ? "Ново съобщение" : message.Message.Body.Trim();

        Text = $"Ново съобщение от {sender}";
        Width = 590;
        Height = 330;
        TopMost = true;
        ShowInTaskbar = true;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        Font = new Font("Segoe UI", 10F);
        BackColor = Color.White;
        StartPosition = FormStartPosition.Manual;

        var header = new Panel { Dock = DockStyle.Top, Height = 64, BackColor = Color.FromArgb(38, 94, 196) };
        header.Controls.Add(new Label
        {
            Text = $"✉  НОВО СЪОБЩЕНИЕ ОТ {sender.ToUpperInvariant()}",
            ForeColor = Color.White,
            Font = new Font("Segoe UI Semibold", 13.5F),
            AutoSize = true,
            MaximumSize = new Size(545, 0),
            Left = 20,
            Top = 17,
        });

        var meta = new Label
        {
            Text = $"{message.CreatedAt.ToLocalTime():dd.MM.yyyy HH:mm}  •  Тема: {subject}",
            ForeColor = Color.DimGray,
            AutoSize = true,
            MaximumSize = new Size(540, 0),
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
            Font = new Font("Segoe UI", 11.5F),
            Left = 22,
            Top = 116,
            Width = 540,
            Height = 118,
            ScrollBars = ScrollBars.Vertical,
            TabStop = false,
        };

        var open = new Button
        {
            Text = "Отвори съобщенията",
            Left = 22,
            Top = 254,
            Width = 190,
            Height = 38,
            BackColor = Color.FromArgb(38, 94, 196),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
        };
        open.FlatAppearance.BorderSize = 0;
        open.Click += (_, _) =>
        {
            Process.Start(new ProcessStartInfo("https://manager-task-management.pages.dev/") { UseShellExecute = true });
            Close();
        };

        var dismiss = new Button { Text = "Разбрах", Left = 442, Top = 254, Width = 120, Height = 38 };
        dismiss.Click += (_, _) => Close();

        Controls.AddRange([header, meta, body, open, dismiss]);
        Shown += (_, _) =>
        {
            var area = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(area.Right - Width - 18, area.Bottom - Height - 18);
            Activate();
            BringToFront();
            NativeAttention.Flash(Handle);
        };
    }
}

internal sealed class InternalMessageState
{
    public DateTimeOffset LastCheckUtc { get; set; } = DateTimeOffset.UtcNow.AddMinutes(-2);
    public Dictionary<string, DateTimeOffset> Seen { get; set; } = new();
}

internal static class InternalMessageStateStore
{
    private static readonly string Folder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "YavlenaManagerTaskNotifier");
    private static readonly string FilePath = Path.Combine(Folder, "message-state.json");

    public static InternalMessageState Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new InternalMessageState();
            return JsonSerializer.Deserialize<InternalMessageState>(File.ReadAllText(FilePath)) ?? new InternalMessageState();
        }
        catch
        {
            return new InternalMessageState();
        }
    }

    public static void Save(InternalMessageState state)
    {
        try
        {
            Directory.CreateDirectory(Folder);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(state));
        }
        catch { }
    }
}

internal sealed class WindowsInternalMessage
{
    [JsonPropertyName("message_id")] public string MessageId { get; set; } = "";
    [JsonPropertyName("created_at")] public DateTimeOffset CreatedAt { get; set; }
    [JsonPropertyName("internal_messages")] public WindowsInternalMessageBody? Message { get; set; }
}

internal sealed class WindowsInternalMessageBody
{
    [JsonPropertyName("sender_name")] public string SenderName { get; set; } = "Колега";
    [JsonPropertyName("subject")] public string? Subject { get; set; }
    [JsonPropertyName("body")] public string Body { get; set; } = "Ново съобщение";
}
