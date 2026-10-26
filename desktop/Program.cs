using System.Diagnostics;
using System.Drawing;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RemoteAgentDesktop;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // Exactly one tray supervisor per user session; a second copy would start competing servers.
        using var singleInstance = new Mutex(true, @"Local\CopilotRemoteAgentDesktop", out bool isFirstInstance);
        if (!isFirstInstance)
        {
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainControlForm(args));
    }
}

public sealed class MainControlForm : Form
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(25) };
    private readonly HttpClient _healthHttp = new() { Timeout = TimeSpan.FromSeconds(5) };
    private readonly string _repoRoot;
    private readonly int _port = 4321;
    private Process? _serverProcess;
    private readonly System.Windows.Forms.Timer _pollTimer;
    private readonly System.Windows.Forms.Timer _supervisorTimer;
    private readonly NotifyIcon _trayIcon;
    private bool _supervising;
    private int _healthFailures;
    private DateTime _serverStartedUtc = DateTime.MinValue;
    private DateTime _nextStartAllowedUtc = DateTime.MinValue;
    private TimeSpan _restartBackoff = TimeSpan.FromSeconds(2);
    private bool _legacyServerDetected;
    private bool _legacyBalloonShowing;
    private DateTime _lastLegacyNoticeUtc = DateTime.MinValue;
    private const string LegacyServerStatusText =
        "⚠ An older Remote Agent server (running as administrator) is blocking the update. Tray menu → \"Finish setup\" to replace it.";

    private readonly Label _statusHeaderLabel;
    private readonly Label _desktopBridgeLabel;
    private readonly Label _mcpServersLabel;
    private readonly Label _lanUrlLabel;
    private readonly Label _wanUrlLabel;
    private readonly Label _leftQrSubLabel;
    private readonly PictureBox _pairQrBox;
    private readonly PictureBox _apkQrBox;
    private readonly Button _wanToggleBtn;
    private readonly Button _copyLinkBtn;
    private readonly Button _openWebBtn;
    private readonly Button _firewallBtn;

    private bool _wanOnline;
    private string _currentPairUrl = "http://localhost:4321";
    private bool _exitingExplicitly;

    public MainControlForm(string[] args)
    {
        _repoRoot = ResolveRepoRoot(args);

        Text = "Copilot Remote Agent — Desktop Control Center";
        Size = new Size(760, 560);
        MinimumSize = new Size(720, 530);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(11, 15, 25);
        ForeColor = Color.FromArgb(248, 250, 252);
        Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
        var brandIcon = CreateBrandIcon();
        Icon = brandIcon;

        // Top Banner
        var topPanel = new Panel
        {
            Dock = DockStyle.Top,
            Height = 68,
            BackColor = Color.FromArgb(17, 24, 39),
            Padding = new Padding(18, 12, 18, 10)
        };

        var titleLabel = new Label
        {
            Text = "🤖 Copilot Remote Agent — Desktop Companion & WAN Bridge",
            Font = new Font("Segoe UI", 13f, FontStyle.Bold),
            ForeColor = Color.FromArgb(56, 189, 248),
            AutoSize = true,
            Location = new Point(18, 11)
        };

        _statusHeaderLabel = new Label
        {
            Text = "Starting local bridge server on port 4321...",
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
            ForeColor = Color.FromArgb(148, 163, 184),
            AutoSize = true,
            Location = new Point(20, 39)
        };

        topPanel.Controls.Add(titleLabel);
        topPanel.Controls.Add(_statusHeaderLabel);

        // Status Info Card
        var infoPanel = new Panel
        {
            Location = new Point(18, 82),
            Size = new Size(708, 118),
            BackColor = Color.FromArgb(30, 41, 59),
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
        };

        _desktopBridgeLabel = new Label
        {
            Text = "Desktop App Bridge: Connecting...",
            Location = new Point(14, 12),
            AutoSize = true,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(248, 250, 252)
        };

        _mcpServersLabel = new Label
        {
            Text = "Active Desktop MCPs: Discovering...",
            Location = new Point(14, 36),
            AutoSize = true,
            ForeColor = Color.FromArgb(192, 132, 252)
        };

        _lanUrlLabel = new Label
        {
            Text = "🏠 LAN Endpoint: http://localhost:4321",
            Location = new Point(14, 62),
            AutoSize = true,
            ForeColor = Color.FromArgb(56, 189, 248)
        };

        _wanUrlLabel = new Label
        {
            Text = "🌍 WAN Tunnel: Stopped (LAN only — click 'Enable Remote WAN' below)",
            Location = new Point(14, 86),
            AutoSize = true,
            ForeColor = Color.FromArgb(148, 163, 184)
        };

        infoPanel.Controls.Add(_desktopBridgeLabel);
        infoPanel.Controls.Add(_mcpServersLabel);
        infoPanel.Controls.Add(_lanUrlLabel);
        infoPanel.Controls.Add(_wanUrlLabel);

        // Left QR Card: Pair Android App
        var leftQrCard = new Panel
        {
            Location = new Point(18, 212),
            Size = new Size(346, 244),
            BackColor = Color.FromArgb(30, 41, 59)
        };
        var leftQrTitle = new Label
        {
            Text = "📱 1. Pair & Connect Android App (LAN / WAN)",
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            Location = new Point(14, 10),
            AutoSize = true
        };
        _pairQrBox = new PictureBox
        {
            Location = new Point(83, 36),
            Size = new Size(180, 180),
            SizeMode = PictureBoxSizeMode.Zoom,
            BackColor = Color.White
        };
        var leftQrSub = new Label
        {
            Text = "Scan with Android camera or enter 6-digit MFA code",
            Font = new Font("Segoe UI", 8.2f),
            ForeColor = Color.FromArgb(148, 163, 184),
            Location = new Point(36, 220),
            AutoSize = true
        };
        _leftQrSubLabel = leftQrSub;
        leftQrCard.Controls.Add(leftQrTitle);
        leftQrCard.Controls.Add(_pairQrBox);
        leftQrCard.Controls.Add(leftQrSub);

        // Right QR Card: Download Native Android APK
        var rightQrCard = new Panel
        {
            Location = new Point(380, 212),
            Size = new Size(346, 244),
            BackColor = Color.FromArgb(30, 41, 59)
        };
        var rightQrTitle = new Label
        {
            Text = "🤖 2. Download Native Android App (.APK)",
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(192, 132, 252),
            Location = new Point(14, 10),
            AutoSize = true
        };
        _apkQrBox = new PictureBox
        {
            Location = new Point(83, 36),
            Size = new Size(180, 180),
            SizeMode = PictureBoxSizeMode.Zoom,
            BackColor = Color.White
        };
        var rightQrSub = new Label
        {
            Text = "Scan on Android to download RemoteAgent-android.apk",
            Font = new Font("Segoe UI", 8.2f),
            ForeColor = Color.FromArgb(148, 163, 184),
            Location = new Point(26, 220),
            AutoSize = true
        };
        rightQrCard.Controls.Add(rightQrTitle);
        rightQrCard.Controls.Add(_apkQrBox);
        rightQrCard.Controls.Add(rightQrSub);

        // Action Buttons Row
        _wanToggleBtn = CreateStyledButton("🌍 Enable Remote WAN", new Point(18, 468), new Size(176, 38), Color.FromArgb(168, 85, 247), Color.White);
        _wanToggleBtn.Click += async (_, _) => await ToggleWanTunnelAsync();

        _openWebBtn = CreateStyledButton("🌐 Open Web Dashboard", new Point(204, 468), new Size(176, 38), Color.FromArgb(56, 189, 248), Color.FromArgb(8, 47, 73));
        _openWebBtn.Click += (_, _) => OpenUrl($"http://localhost:{_port}");

        _copyLinkBtn = CreateStyledButton("📋 Copy Pairing URL", new Point(390, 468), new Size(160, 38), Color.FromArgb(38, 51, 73), Color.White);
        _copyLinkBtn.Click += (_, _) =>
        {
            Clipboard.SetText(_currentPairUrl);
            MessageBox.Show($"Copied pairing URL to clipboard:\n\n{_currentPairUrl}", "Copilot Remote Agent", MessageBoxButtons.OK, MessageBoxIcon.Information);
        };

        _firewallBtn = CreateStyledButton("🛡️ Allow LAN Firewall", new Point(560, 468), new Size(166, 38), Color.FromArgb(38, 51, 73), Color.White);
        _firewallBtn.Click += (_, _) => ConfigureFirewallRule();

        Controls.Add(topPanel);
        Controls.Add(infoPanel);
        Controls.Add(leftQrCard);
        Controls.Add(rightQrCard);
        Controls.Add(_wanToggleBtn);
        Controls.Add(_openWebBtn);
        Controls.Add(_copyLinkBtn);
        Controls.Add(_firewallBtn);

        // System Tray Icon
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("Open Control Center", null, (_, _) => ShowFromTray());
        trayMenu.Items.Add("Open Setup & Options Wizard...", null, (_, _) => OpenSetupWizard());
        trayMenu.Items.Add("Open Web Dashboard", null, (_, _) => OpenUrl($"http://localhost:{_port}"));
        trayMenu.Items.Add("Toggle Remote WAN Tunnel", null, async (_, _) => await ToggleWanTunnelAsync());
        var autoStartItem = new ToolStripMenuItem("Start Automatically with Windows")
        {
            Checked = IsAutoStartEnabled(),
            CheckOnClick = true
        };
        autoStartItem.CheckedChanged += (_, _) => SetAutoStartEnabled(autoStartItem.Checked);
        trayMenu.Items.Add(autoStartItem);

        var autoCopilotItem = new ToolStripMenuItem("Auto-Launch GitHub Copilot Desktop on Startup")
        {
            Checked = IsAutoLaunchCopilotEnabled(),
            CheckOnClick = true
        };
        autoCopilotItem.CheckedChanged += (_, _) => SetAutoLaunchCopilotEnabled(autoCopilotItem.Checked);
        trayMenu.Items.Add(autoCopilotItem);

        trayMenu.Items.Add("Finish setup: replace old admin server && enable restart sign-in (UAC)...", null, (_, _) => EnableUpdateAutoSignIn());
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("Quit Copilot Remote Agent", null, (_, _) =>
        {
            _exitingExplicitly = true;
            Close();
        });

        _trayIcon = new NotifyIcon
        {
            Icon = brandIcon,
            Text = "Copilot Remote Agent (HTTPS WAN + LAN)",
            ContextMenuStrip = trayMenu,
            Visible = true
        };
        _trayIcon.DoubleClick += (_, _) => ShowFromTray();
        _trayIcon.BalloonTipClicked += (_, _) =>
        {
            if (_legacyBalloonShowing)
            {
                _legacyBalloonShowing = false;
                EnableUpdateAutoSignIn();
            }
        };
        _trayIcon.BalloonTipClosed += (_, _) => _legacyBalloonShowing = false;

        // Ensure auto-start with Windows is registered by default
        if (!IsAutoStartEnabled())
        {
            SetAutoStartEnabled(true);
            autoStartItem.Checked = true;
        }

        bool startMinimized = args.Any(a => a.Equals("--minimized", StringComparison.OrdinalIgnoreCase) || a.Equals("--tray", StringComparison.OrdinalIgnoreCase));
        if (startMinimized)
        {
            WindowState = FormWindowState.Minimized;
            ShowInTaskbar = false;
        }

        // UI refresh is cosmetic; keep it light and only while the window is visible.
        _pollTimer = new System.Windows.Forms.Timer { Interval = 10_000 };
        _pollTimer.Tick += async (_, _) =>
        {
            if (Visible && WindowState != FormWindowState.Minimized)
            {
                await RefreshStatusAsync();
            }
        };

        _supervisorTimer = new System.Windows.Forms.Timer { Interval = 5_000 };
        _supervisorTimer.Tick += async (_, _) => await SuperviseServerAsync();

        Load += async (_, _) =>
        {
            if (startMinimized)
            {
                Hide();
            }
            if (IsAutoLaunchCopilotEnabled())
            {
                EnsureGitHubCopilotDesktopRunning();
                EnsureConfiguredStartupAppsRunning();
            }
            await SuperviseServerAsync();
            _supervisorTimer.Start();
            if (!startMinimized)
            {
                await RefreshStatusAsync();
            }
            _pollTimer.Start();
        };

        VisibleChanged += async (_, _) =>
        {
            if (Visible)
            {
                await RefreshStatusAsync();
            }
        };

        FormClosing += (_, e) =>
        {
            if (!_exitingExplicitly && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                _trayIcon.ShowBalloonTip(
                    2000,
                    "Copilot Remote Agent",
                    "Still running in the system tray so your Android phone stays connected.",
                    ToolTipIcon.Info
                );
                return;
            }

            _pollTimer.Stop();
            _supervisorTimer.Stop();
            _trayIcon.Visible = false;
            StopBackendServer();
        };
    }

    private static Icon CreateBrandIcon()
    {
        using var bmp = new Bitmap(64, 64);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.FromArgb(11, 15, 25));

            using var borderPen = new Pen(Color.FromArgb(56, 189, 248), 3f);
            using var headBrush = new SolidBrush(Color.FromArgb(19, 28, 49));
            g.FillEllipse(headBrush, 8, 12, 48, 42);
            g.DrawEllipse(borderPen, 8, 12, 48, 42);

            using var visorBrush = new SolidBrush(Color.FromArgb(9, 13, 22));
            g.FillRectangle(visorBrush, 16, 22, 32, 16);

            using var eyeBrush = new SolidBrush(Color.FromArgb(56, 189, 248));
            g.FillEllipse(eyeBrush, 20, 25, 8, 10);
            g.FillEllipse(eyeBrush, 36, 25, 8, 10);

            using var mouthPen = new Pen(Color.FromArgb(192, 132, 252), 3f);
            g.DrawLine(mouthPen, 24, 44, 40, 44);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    private static Button CreateStyledButton(string text, Point location, Size size, Color back, Color fore)
    {
        return new Button
        {
            Text = text,
            Location = location,
            Size = size,
            BackColor = back,
            ForeColor = fore,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 9f, FontStyle.Bold),
            Cursor = Cursors.Hand
        };
    }

    private static string ResolveRepoRoot(string[] args)
    {
        foreach (var arg in args)
        {
            if (!arg.StartsWith("--") && Directory.Exists(arg))
            {
                return Path.GetFullPath(arg);
            }
        }

        string dir = AppContext.BaseDirectory;
        for (int i = 0; i < 6; i++)
        {
            if (File.Exists(Path.Combine(dir, "package.json")) && File.Exists(Path.Combine(dir, "src", "server.ts")))
            {
                return dir;
            }
            var parent = Directory.GetParent(dir);
            if (parent == null) break;
            dir = parent.FullName;
        }

        string configMarker = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".copilot",
            "remote-agent-repo-path.txt"
        );
        if (File.Exists(configMarker))
        {
            string saved = File.ReadAllText(configMarker).Trim();
            if (Directory.Exists(saved)) return saved;
        }

        return Directory.GetCurrentDirectory();
    }

    /// <summary>
    /// Keeps exactly one healthy bridge server running. A busy server is given ~20s of failed
    /// health checks before it is restarted, and a port held by another process is never duplicated.
    /// </summary>
    private async Task SuperviseServerAsync()
    {
        if (_supervising) return;
        _supervising = true;
        try
        {
            var health = await ProbeServerHealthAsync();
            if (health.Healthy)
            {
                _healthFailures = 0;
                bool ownsHealthyServer = _serverProcess is { HasExited: false };
                _legacyServerDetected = health.Legacy && !ownsHealthyServer;
                if (_legacyServerDetected)
                {
                    NotifyLegacyServerBlocking();
                }
                if (_serverStartedUtc != DateTime.MinValue && DateTime.UtcNow - _serverStartedUtc > TimeSpan.FromMinutes(2))
                {
                    _restartBackoff = TimeSpan.FromSeconds(2);
                }
                return;
            }
            _legacyServerDetected = false;

            bool ownsRunningServer = _serverProcess is { HasExited: false };
            if (ownsRunningServer && DateTime.UtcNow - _serverStartedUtc < TimeSpan.FromSeconds(25))
            {
                return; // Still starting up
            }

            _healthFailures++;
            if (ownsRunningServer)
            {
                if (_healthFailures < 4) return;
                StopBackendServer();
            }
            else if (IsPortListening())
            {
                _statusHeaderLabel.Text = $"Port {_port} is held by another process; waiting for it to respond...";
                return;
            }

            if (DateTime.UtcNow < _nextStartAllowedUtc) return;
            await StartBackendServerAsync();
            _nextStartAllowedUtc = DateTime.UtcNow + _restartBackoff;
            _restartBackoff = TimeSpan.FromSeconds(Math.Min(60, _restartBackoff.TotalSeconds * 2));
            _healthFailures = 0;
        }
        finally
        {
            _supervising = false;
        }
    }

    private bool IsPortListening()
    {
        try
        {
            return System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties()
                .GetActiveTcpListeners()
                .Any(ep => ep.Port == _port);
        }
        catch
        {
            return false;
        }
    }

    private static string ResolveNodeExecutable()
    {
        string? pathEnv = Environment.GetEnvironmentVariable("PATH");
        foreach (string dir in (pathEnv ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim('"'), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // Ignore malformed PATH entries
            }
        }
        string programFilesNode = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "nodejs",
            "node.exe"
        );
        return File.Exists(programFilesNode) ? programFilesNode : "node.exe";
    }

    private async Task StartBackendServerAsync()
    {
        try
        {
            if (!Directory.Exists(Path.Combine(_repoRoot, "node_modules")))
            {
                _statusHeaderLabel.Text = "First-run setup: Installing Node.js dependencies (npm install)...";
                var installPsi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c npm install --no-audit --no-fund",
                    WorkingDirectory = _repoRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                var installProc = Process.Start(installPsi);
                if (installProc != null)
                {
                    await installProc.WaitForExitAsync();
                }
            }

            // Start node directly (not via cmd/npm) so this supervisor owns and can stop the real server process.
            var psi = new ProcessStartInfo
            {
                FileName = ResolveNodeExecutable(),
                Arguments = "--no-warnings --import tsx src/server.ts",
                WorkingDirectory = _repoRoot,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            psi.Environment["PORT"] = _port.ToString();
            _serverProcess = Process.Start(psi);
            _serverStartedUtc = DateTime.UtcNow;
            _statusHeaderLabel.Text = "Starting local bridge server on port 4321...";
        }
        catch (Exception ex)
        {
            _statusHeaderLabel.Text = $"Failed to start server: {ex.Message}";
        }
    }

    private async Task<bool> IsServerListeningAsync()
    {
        return (await ProbeServerHealthAsync()).Healthy;
    }

    /// <summary>
    /// Servers built before the reliability overhaul do not report serverStartedAt; one of those
    /// still holding the port (typically launched by the old elevated scheduled task) blocks the update.
    /// </summary>
    private async Task<(bool Healthy, bool Legacy)> ProbeServerHealthAsync()
    {
        try
        {
            using var res = await _healthHttp.GetAsync($"http://127.0.0.1:{_port}/api/health");
            if (!res.IsSuccessStatusCode) return (false, false);
            string body = await res.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            bool legacy = doc.RootElement.ValueKind == JsonValueKind.Object &&
                !doc.RootElement.TryGetProperty("serverStartedAt", out _);
            return (true, legacy);
        }
        catch
        {
            return (false, false);
        }
    }

    private void NotifyLegacyServerBlocking()
    {
        _statusHeaderLabel.Text = LegacyServerStatusText;
        if (DateTime.UtcNow - _lastLegacyNoticeUtc < TimeSpan.FromHours(2)) return;
        _lastLegacyNoticeUtc = DateTime.UtcNow;
        _legacyBalloonShowing = true;
        _trayIcon.ShowBalloonTip(
            30_000,
            "Copilot Remote Agent: finish the update",
            "An older server running as administrator is still answering your phone. Click here and approve the prompt to switch to the updated server.",
            ToolTipIcon.Warning
        );
    }

    private void StopBackendServer()
    {
        if (_serverProcess is { HasExited: false })
        {
            try
            {
                _serverProcess.Kill(entireProcessTree: true);
                _serverProcess.WaitForExit(5000);
            }
            catch
            {
                // Ignore
            }
        }
        _serverProcess = null;
    }

    private async Task RefreshStatusAsync()
    {
        try
        {
            string statusJson = await _http.GetStringAsync($"http://127.0.0.1:{_port}/api/status");
            using var statusDoc = JsonDocument.Parse(statusJson);
            var root = statusDoc.RootElement;

            string hostname = root.GetProperty("hostname").GetString() ?? "Desktop";
            bool appConnected = root.GetProperty("desktopAppConnected").GetBoolean();
            int activeSessions = root.GetProperty("activeSessionsCount").GetInt32();
            int totalSessions = root.GetProperty("totalSessionsCount").GetInt32();

            _statusHeaderLabel.Text = _legacyServerDetected
                ? LegacyServerStatusText
                : $"Host: {hostname} • Local Port: {_port} • Sessions: {activeSessions} running / {totalSessions} total";
            _desktopBridgeLabel.Text = appConnected
                ? "✅ GitHub Copilot Desktop App Bridge: Connected Live (WebSocket + SDK)"
                : "🟡 GitHub Copilot Desktop App Bridge: Standalone Copilot SDK & Session Watcher Ready";

            var mcps = new List<string>();
            if (root.TryGetProperty("mcpServers", out var mcpArr) && mcpArr.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in mcpArr.EnumerateArray())
                {
                    if (item.TryGetProperty("name", out var n)) mcps.Add(n.GetString() ?? "");
                }
            }
            _mcpServersLabel.Text = $"🔌 Active Desktop MCPs: {(mcps.Count > 0 ? string.Join(", ", mcps) : "None")}";

            string pairJson = await _http.GetStringAsync($"http://127.0.0.1:{_port}/api/pair-info");
            using var pairDoc = JsonDocument.Parse(pairJson);
            var pairRoot = pairDoc.RootElement;

            string lanBase = pairRoot.GetProperty("lanBase").GetString() ?? $"http://localhost:{_port}";
            _lanUrlLabel.Text = $"🏠 LAN Endpoint: {lanBase}";

            _currentPairUrl = pairRoot.GetProperty("pairUrl").GetString() ?? lanBase;

            if (pairRoot.TryGetProperty("wan", out var wanEl))
            {
                string wanStatus = wanEl.GetProperty("status").GetString() ?? "stopped";
                string? pubUrl = wanEl.TryGetProperty("publicUrl", out var pEl) && pEl.ValueKind == JsonValueKind.String
                    ? pEl.GetString()
                    : null;

                _wanOnline = wanStatus == "online" && !string.IsNullOrEmpty(pubUrl);
                if (_wanOnline)
                {
                    _wanUrlLabel.Text = $"🌍 WAN Tunnel (LIVE HTTPS): {pubUrl}";
                    _wanUrlLabel.ForeColor = Color.FromArgb(34, 197, 94);
                    _wanToggleBtn.Text = "⏹ Stop WAN Tunnel";
                    _wanToggleBtn.BackColor = Color.FromArgb(239, 68, 68);
                }
                else if (wanStatus is "starting" or "installing")
                {
                    _wanUrlLabel.Text = $"🌍 WAN Tunnel: {wanStatus.ToUpperInvariant()} Cloudflare HTTPS tunnel...";
                    _wanUrlLabel.ForeColor = Color.FromArgb(245, 158, 11);
                }
                else
                {
                    _wanUrlLabel.Text = "🌍 WAN Tunnel: Stopped (LAN only — click 'Enable Remote WAN' below)";
                    _wanUrlLabel.ForeColor = Color.FromArgb(148, 163, 184);
                    _wanToggleBtn.Text = "🌍 Enable Remote WAN";
                    _wanToggleBtn.BackColor = Color.FromArgb(168, 85, 247);
                }
            }

            if (pairRoot.TryGetProperty("mfa", out var mfaEl) && mfaEl.TryGetProperty("code", out var codeEl))
            {
                string code = codeEl.GetString() ?? "";
                if (code.Length == 6)
                {
                    _leftQrSubLabel.Text = $"Scan QR or enter 6-Digit MFA Code: {code[..3]} {code[3..]}";
                    _leftQrSubLabel.ForeColor = Color.FromArgb(88, 166, 255);
                    _leftQrSubLabel.Font = new Font("Segoe UI", 8.8f, FontStyle.Bold);
                }
            }

            if (pairRoot.TryGetProperty("qrDataUrl", out var qrEl) && qrEl.ValueKind == JsonValueKind.String)
            {
                UpdatePictureBoxFromDataUrl(_pairQrBox, qrEl.GetString()!);
            }
            if (pairRoot.TryGetProperty("apkQrDataUrl", out var apkQrEl) && apkQrEl.ValueKind == JsonValueKind.String)
            {
                UpdatePictureBoxFromDataUrl(_apkQrBox, apkQrEl.GetString()!);
            }
        }
        catch
        {
            // The supervisor timer owns restarts; the UI only reports the current state.
            _statusHeaderLabel.Text = $"Waiting for the local bridge server on port {_port}...";
        }
    }

    private static void UpdatePictureBoxFromDataUrl(PictureBox box, string dataUrl)
    {
        const string prefix = "data:image/png;base64,";
        if (!dataUrl.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return;
        string b64 = dataUrl[prefix.Length..];
        if (box.Tag as string == b64) return;
        box.Tag = b64;
        byte[] bytes = Convert.FromBase64String(b64);
        using var ms = new MemoryStream(bytes);
        box.Image = Image.FromStream(ms);
    }

    private async Task ToggleWanTunnelAsync()
    {
        try
        {
            _wanToggleBtn.Enabled = false;
            if (_wanOnline)
            {
                await _http.PostAsync($"http://127.0.0.1:{_port}/api/wan/stop", new StringContent("{}", Encoding.UTF8, "application/json"));
            }
            else
            {
                _wanUrlLabel.Text = "🌍 WAN Tunnel: Provisioning Cloudflare HTTPS tunnel...";
                _wanUrlLabel.ForeColor = Color.FromArgb(245, 158, 11);
                await _http.PostAsync(
                    $"http://127.0.0.1:{_port}/api/wan/start",
                    new StringContent("{\"persistAutoStart\":true}", Encoding.UTF8, "application/json")
                );
            }
            await RefreshStatusAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"WAN Tunnel operation failed: {ex.Message}", "Copilot Remote Agent", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _wanToggleBtn.Enabled = true;
        }
    }

    private void ShowFromTray()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private const string RunRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "CopilotRemoteAgent";

    private bool IsAutoStartEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, false);
            return key?.GetValue(RunValueName) is string s && !string.IsNullOrWhiteSpace(s);
        }
        catch
        {
            return false;
        }
    }

    private void SetAutoStartEnabled(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, true);
            if (key == null) return;
            if (enabled)
            {
                string exePath = Environment.ProcessPath ?? Application.ExecutablePath;
                key.SetValue(RunValueName, $"\"{exePath}\" --minimized \"{_repoRoot}\"");
            }
            else
            {
                key.DeleteValue(RunValueName, false);
            }
        }
        catch
        {
            // Ignore registry errors
        }
    }

    private static void EnsureGitHubCopilotDesktopRunning()
    {
        try
        {
            if (Process.GetProcessesByName("github").Length > 0) return;
            string ghExe = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "GitHub Copilot",
                "github.exe"
            );
            if (File.Exists(ghExe))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = ghExe,
                    UseShellExecute = true
                });
            }
        }
        catch
        {
            // Ignore if not installed
        }
    }

    private static string GetCopilotAutoLaunchMarkerPath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".copilot", "remote-agent-autolaunch-apps.txt");

    private static bool IsAutoLaunchCopilotEnabled()
    {
        try
        {
            string marker = GetCopilotAutoLaunchMarkerPath();
            if (!File.Exists(marker)) return true;
            return File.ReadAllText(marker).Trim() != "0";
        }
        catch
        {
            return true;
        }
    }

    private static void SetAutoLaunchCopilotEnabled(bool enabled)
    {
        try
        {
            string marker = GetCopilotAutoLaunchMarkerPath();
            Directory.CreateDirectory(Path.GetDirectoryName(marker)!);
            File.WriteAllText(marker, enabled ? "1" : "0");
        }
        catch
        {
            // Ignore
        }
    }

    private static void EnsureConfiguredStartupAppsRunning()
    {
        try
        {
            string appsConfigPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".copilot",
                "remote-agent-startup-apps.json"
            );
            if (!File.Exists(appsConfigPath)) return;

            using var doc = JsonDocument.Parse(File.ReadAllText(appsConfigPath));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return;

            foreach (var item in doc.RootElement.EnumerateArray())
            {
                string? exePath = item.ValueKind == JsonValueKind.String
                    ? item.GetString()
                    : (item.TryGetProperty("executablePath", out var ep) ? ep.GetString() : null);

                if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath)) continue;
                string procName = Path.GetFileNameWithoutExtension(exePath);
                if (Process.GetProcessesByName(procName).Length > 0) continue;

                Process.Start(new ProcessStartInfo
                {
                    FileName = exePath,
                    UseShellExecute = true
                });
            }
        }
        catch
        {
            // Ignore malformed user startup app config
        }
    }

    private static void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch
        {
            // Ignore
        }
    }

    private void ConfigureFirewallRule()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -Command \"New-NetFirewallRule -DisplayName 'GitHub Copilot Remote Agent (LAN)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {_port} -Profile Private,Domain -ErrorAction Stop\"",
                Verb = "runas",
                UseShellExecute = true
            };
            Process.Start(psi);
        }
        catch
        {
            // User cancelled UAC or already configured
        }
    }

    private void EnableUpdateAutoSignIn()
    {
        try
        {
            string scriptPath = Path.Combine(_repoRoot, "scripts", "enable-update-auto-signin.ps1");
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{scriptPath}\"",
                Verb = "runas",
                UseShellExecute = true
            };
            Process.Start(psi);
        }
        catch
        {
            // User cancelled UAC
        }
    }

    private void OpenSetupWizard()
    {
        try
        {
            string setupExe = Path.Combine(_repoRoot, "releases", "RemoteAgent-Desktop-Setup.exe");
            if (File.Exists(setupExe))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = setupExe,
                    WorkingDirectory = _repoRoot,
                    UseShellExecute = true
                });
            }
        }
        catch
        {
            // Ignore
        }
    }
}
