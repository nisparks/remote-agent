using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RemoteAgentSetup;

public sealed class InstallOptions
{
    public string WanMode { get; set; } = "cloudflare"; // "cloudflare" | "custom" | "lan"
    public string CustomWanUrl { get; set; } = "";
    public bool AutoStartLogin { get; set; } = true;
    public bool EnableUpdateAutoSignIn { get; set; } = false;
    public bool AutoLaunchCopilotDesktop { get; set; } = true;
    public bool ConfigureFirewall { get; set; } = false;
    public bool CreateDesktopShortcut { get; set; } = true;
    public bool CreateStartMenuShortcut { get; set; } = true;
    public string PeerPairingUrl { get; set; } = "";
    public bool LaunchNow { get; set; } = true;
}

internal static class SetupProgram
{
    [STAThread]
    static void Main(string[] args)
    {
        if (args.Contains("--silent"))
        {
            PerformInstall(new InstallOptions { LaunchNow = false });
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new InstallerForm());
    }

    public static string ResolveRepoRoot()
    {
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

        string marker = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".copilot", "remote-agent-repo-path.txt");
        if (File.Exists(marker))
        {
            string saved = File.ReadAllText(marker).Trim();
            if (Directory.Exists(saved)) return saved;
        }
        return Directory.GetCurrentDirectory();
    }

    public static (string wanMode, string customWanUrl, bool autoLaunchApps) LoadExistingConfig()
    {
        string copilotDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".copilot");
        string wanPath = Path.Combine(copilotDir, "remote-agent-wan.json");
        string appsPath = Path.Combine(copilotDir, "remote-agent-autolaunch-apps.txt");

        string wanMode = "cloudflare";
        string customUrl = "";
        bool autoApps = true;

        try
        {
            if (File.Exists(wanPath))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(wanPath));
                var root = doc.RootElement;
                if (root.TryGetProperty("customWanUrl", out var cu) && cu.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(cu.GetString()))
                {
                    customUrl = cu.GetString()!.Trim();
                    wanMode = "custom";
                }
                else if (root.TryGetProperty("autoStart", out var aus) && aus.ValueKind == JsonValueKind.False)
                {
                    wanMode = "lan";
                }
            }
            if (File.Exists(appsPath))
            {
                autoApps = File.ReadAllText(appsPath).Trim() != "0";
            }
        }
        catch
        {
            // Ignore
        }
        return (wanMode, customUrl, autoApps);
    }

    public static string PerformInstall(InstallOptions opts)
    {
        string repoRoot = ResolveRepoRoot();
        string installDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs",
            "CopilotRemoteAgent"
        );
        Directory.CreateDirectory(installDir);

        string copilotDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".copilot");
        Directory.CreateDirectory(copilotDir);
        File.WriteAllText(Path.Combine(copilotDir, "remote-agent-repo-path.txt"), repoRoot);

        // 0. Ensure Node.js & workspace repo are ready (even if user downloaded only Setup.exe!)
        if (!File.Exists(Path.Combine(repoRoot, "package.json")))
        {
            string defaultWorkspace = Path.Combine(installDir, "workspace");
            if (!File.Exists(Path.Combine(defaultWorkspace, "package.json")))
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "git",
                        Arguments = $"clone https://github.com/nisparks/remote-agent.git \"{defaultWorkspace}\"",
                        CreateNoWindow = true,
                        UseShellExecute = false
                    })?.WaitForExit(90_000);
                }
                catch
                {
                    // Ignore if git not installed
                }
            }
            if (File.Exists(Path.Combine(defaultWorkspace, "package.json")))
            {
                repoRoot = defaultWorkspace;
                File.WriteAllText(Path.Combine(copilotDir, "remote-agent-repo-path.txt"), repoRoot);
            }
        }

        if (!Directory.Exists(Path.Combine(repoRoot, "node_modules")))
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c npm install --no-audit --no-fund",
                    WorkingDirectory = repoRoot,
                    CreateNoWindow = true,
                    UseShellExecute = false
                })?.WaitForExit(90_000);
            }
            catch
            {
                // Ignore if npm not in PATH
            }
        }

        // 1. Save WAN configuration
        string wanConfigPath = Path.Combine(copilotDir, "remote-agent-wan.json");
        var wanObj = new Dictionary<string, object?>
        {
            ["autoStart"] = opts.WanMode == "cloudflare",
            ["customWanUrl"] = opts.WanMode == "custom" && !string.IsNullOrWhiteSpace(opts.CustomWanUrl)
                ? opts.CustomWanUrl.Trim().TrimEnd('/')
                : null
        };
        File.WriteAllText(wanConfigPath, JsonSerializer.Serialize(wanObj, new JsonSerializerOptions { WriteIndented = true }));

        // 2. Save Copilot Desktop & companion apps auto-launch preference
        File.WriteAllText(Path.Combine(copilotDir, "remote-agent-autolaunch-apps.txt"), opts.AutoLaunchCopilotDesktop ? "1" : "0");

        // 3. Copy Desktop binaries
        string sourceAppDir = Path.Combine(repoRoot, "releases", "desktop-app");
        if (Directory.Exists(sourceAppDir))
        {
            foreach (string file in Directory.GetFiles(sourceAppDir))
            {
                string dest = Path.Combine(installDir, Path.GetFileName(file));
                try
                {
                    File.Copy(file, dest, overwrite: true);
                }
                catch
                {
                    // Ignore if currently running
                }
            }
        }

        string exePath = Path.Combine(installDir, "RemoteAgentDesktop.exe");
        if (!File.Exists(exePath))
        {
            exePath = Path.Combine(repoRoot, "releases", "desktop-app", "RemoteAgentDesktop.exe");
        }

        // 4. Shortcuts
        if (opts.CreateDesktopShortcut)
        {
            string desktopLnk = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "Copilot Remote Agent.lnk"
            );
            CreateShortcut(desktopLnk, exePath, repoRoot);
        }

        if (opts.CreateStartMenuShortcut)
        {
            string startMenuLnk = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                "Copilot Remote Agent.lnk"
            );
            CreateShortcut(startMenuLnk, exePath, repoRoot);
        }

        // 5. Windows Login Auto-Start & Winlogon RestartApps
        try
        {
            using var runKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
            if (opts.AutoStartLogin)
            {
                runKey?.SetValue("CopilotRemoteAgent", $"\"{exePath}\" --minimized \"{repoRoot}\"");
                using var winlogonKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows NT\CurrentVersion\Winlogon", true);
                winlogonKey?.SetValue("RestartApps", 1, RegistryValueKind.DWord);
            }
            else
            {
                runKey?.DeleteValue("CopilotRemoteAgent", false);
            }
        }
        catch
        {
            // Ignore registry errors
        }

        // 6. Optional sign-in after Windows Update restarts (ARSO, UAC)
        if (opts.EnableUpdateAutoSignIn)
        {
            try
            {
                string scriptPath = Path.Combine(repoRoot, "scripts", "enable-update-auto-signin.ps1");
                if (File.Exists(scriptPath))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "powershell.exe",
                        Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{scriptPath}\"",
                        Verb = "runas",
                        UseShellExecute = true
                    })?.WaitForExit(10000);
                }
            }
            catch
            {
                // User cancelled UAC
            }
        }

        // 7. Optional Windows Firewall Rule (UAC)
        if (opts.ConfigureFirewall)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -Command \"New-NetFirewallRule -DisplayName 'GitHub Copilot Remote Agent (4321)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4321 -Profile Private,Domain,Public -ErrorAction SilentlyContinue\"",
                    Verb = "runas",
                    UseShellExecute = true
                })?.WaitForExit(8000);
            }
            catch
            {
                // Ignore
            }
        }

        // 8. Optional Multi-Machine Peer Hub Join
        if (!string.IsNullOrWhiteSpace(opts.PeerPairingUrl))
        {
            try
            {
                string wizardScript = Path.Combine(repoRoot, "scripts", "setup-wizard.mjs");
                if (File.Exists(wizardScript))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "node",
                        Arguments = $"\"{wizardScript}\" --join \"{opts.PeerPairingUrl.Trim()}\"",
                        WorkingDirectory = repoRoot,
                        CreateNoWindow = true,
                        UseShellExecute = false
                    })?.WaitForExit(6000);
                }
            }
            catch
            {
                // Ignore
            }
        }

        if (opts.LaunchNow && File.Exists(exePath))
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = exePath,
                Arguments = $"\"{repoRoot}\"",
                WorkingDirectory = repoRoot,
                UseShellExecute = true
            });
        }

        return installDir;
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDir)
    {
        try
        {
            string psScript = $"$s=(New-Object -COM WScript.Shell).CreateShortcut('{shortcutPath.Replace("'", "''")}');" +
                              $"$s.TargetPath='{targetPath.Replace("'", "''")}';" +
                              $"$s.Arguments='\"{workingDir.Replace("'", "''")}\"';" +
                              $"$s.WorkingDirectory='{workingDir.Replace("'", "''")}';" +
                              $"$s.Description='GitHub Copilot Remote Agent Desktop Control Center';" +
                              "$s.Save()";
            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -NonInteractive -Command \"{psScript}\"",
                CreateNoWindow = true,
                UseShellExecute = false
            })?.WaitForExit(4000);
        }
        catch
        {
            // Ignore shortcut creation errors
        }
    }
}

public sealed class InstallerForm : Form
{
    private readonly RadioButton _wanCloudflareRadio;
    private readonly RadioButton _wanCustomRadio;
    private readonly RadioButton _wanLanRadio;
    private readonly TextBox _customWanUrlBox;

    private readonly CheckBox _autoStartLoginChk;
    private readonly CheckBox _updateAutoSignInChk;
    private readonly CheckBox _autoAppsChk;
    private readonly CheckBox _firewallChk;
    private readonly CheckBox _desktopChk;
    private readonly CheckBox _startMenuChk;
    private readonly CheckBox _launchChk;

    private readonly TextBox _peerHubUrlBox;
    private readonly Label _statusLabel;

    public InstallerForm()
    {
        var existing = SetupProgram.LoadExistingConfig();

        Text = "Copilot Remote Agent — Setup & Configuration Wizard";
        Size = new Size(640, 710);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        BackColor = Color.FromArgb(13, 17, 23);
        ForeColor = Color.FromArgb(230, 237, 243);
        Font = new Font("Segoe UI", 9.5f);

        var title = new Label
        {
            Text = "Copilot Remote Agent — Setup & Onboarding Wizard",
            Font = new Font("Segoe UI", 13.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(230, 237, 243),
            Location = new Point(22, 16),
            AutoSize = true
        };

        var sub = new Label
        {
            Text = "Configure WAN access, unattended Windows Update recovery, companion app startup, and multi-machine linking.",
            Location = new Point(24, 44),
            Size = new Size(580, 24),
            ForeColor = Color.FromArgb(139, 148, 158)
        };

        // Section 1: WAN Mode + Interactive Setup Guide
        var wanPanel = CreateSectionPanel("1. Remote WAN Access Mode (5G / Outside Home Wi-Fi)", new Point(22, 76), new Size(582, 200));

        _wanCloudflareRadio = new RadioButton
        {
            Text = "Zero-Config Cloudflare HTTPS Tunnel (Free — no router or DDNS setup required)",
            Location = new Point(16, 30),
            AutoSize = true,
            Checked = existing.wanMode == "cloudflare"
        };

        _wanCustomRadio = new RadioButton
        {
            Text = "Custom HTTPS Domain / Dynamic DNS + Router Port Forward (Permanent URL across reboots):",
            Location = new Point(16, 58),
            AutoSize = true,
            Checked = existing.wanMode == "custom"
        };

        _customWanUrlBox = new TextBox
        {
            Text = existing.customWanUrl,
            PlaceholderText = "https://remote.example.com:4321",
            Location = new Point(38, 84),
            Size = new Size(520, 25),
            BackColor = Color.FromArgb(13, 17, 23),
            ForeColor = Color.FromArgb(230, 237, 243),
            BorderStyle = BorderStyle.FixedSingle
        };

        _wanLanRadio = new RadioButton
        {
            Text = "Local Wi-Fi LAN / Tailscale VPN / Secondary LAN Machine",
            Location = new Point(16, 115),
            AutoSize = true,
            Checked = existing.wanMode == "lan"
        };

        var wanGuideLabel = new Label
        {
            Location = new Point(16, 144),
            Size = new Size(550, 48),
            Font = new Font("Segoe UI", 8.5f),
            ForeColor = Color.FromArgb(125, 211, 252)
        };

        void UpdateWanGuideText()
        {
            if (_wanCustomRadio.Checked)
            {
                wanGuideLabel.Text = "Guide: (1) On your router, forward external TCP port 4321 -> this PC's LAN IP:4321 and enable Hairpin NAT (NAT Loopback) so the WAN URL works on both 5G & home Wi-Fi. (2) Place TLS cert.pem/key.pem in ~/.copilot/tls/ (or use auto-generated fallback TLS). Permanent across reboots.";
            }
            else if (_wanLanRadio.Checked)
            {
                wanGuideLabel.Text = "Guide: Zero router rules needed. Connect on home Wi-Fi (http://192.168.x.x:4321), over Tailscale VPN (http://100.x.y.z:4321 — permanent across reboots), or link this PC to a Primary WAN Desktop in Section 3 below to piggyback on its WAN port.";
            }
            else
            {
                wanGuideLabel.Text = "Guide: Downloads official cloudflared on demand and opens an outbound HTTPS tunnel with zero router rules. Note: Free Quick Tunnels change URL if the PC reboots while away; use Tailscale or Custom DDNS for a permanent URL across unattended reboots.";
            }
        }

        _wanCloudflareRadio.CheckedChanged += (_, _) => UpdateWanGuideText();
        _wanCustomRadio.CheckedChanged += (_, _) => UpdateWanGuideText();
        _wanLanRadio.CheckedChanged += (_, _) => UpdateWanGuideText();
        UpdateWanGuideText();

        wanPanel.Controls.Add(_wanCloudflareRadio);
        wanPanel.Controls.Add(_wanCustomRadio);
        wanPanel.Controls.Add(_customWanUrlBox);
        wanPanel.Controls.Add(_wanLanRadio);
        wanPanel.Controls.Add(wanGuideLabel);

        // Section 2: Startup, Unattended Reboot & App Auto-Launch
        var startupPanel = CreateSectionPanel("2. Windows Startup, Unattended Reboots & Desktop Apps", new Point(22, 288), new Size(582, 212));

        _autoStartLoginChk = new CheckBox
        {
            Text = "Start Automatically with Windows Login (System Tray + Winlogon RestartApps after Updates)",
            Checked = true,
            Location = new Point(16, 30),
            AutoSize = true
        };

        _updateAutoSignInChk = new CheckBox
        {
            Text = "Sign in automatically after Windows Update restarts so the bridge comes back (UAC)",
            Checked = false,
            Location = new Point(16, 58),
            AutoSize = true
        };

        _autoAppsChk = new CheckBox
        {
            Text = "Auto-Launch GitHub Copilot Desktop & configured startup apps on login",
            Checked = existing.autoLaunchApps,
            Location = new Point(16, 86),
            AutoSize = true
        };

        _firewallChk = new CheckBox
        {
            Text = "Add Windows Firewall Inbound Rule for TCP Port 4321 (UAC)",
            Checked = false,
            Location = new Point(16, 114),
            AutoSize = true
        };

        _desktopChk = new CheckBox
        {
            Text = "Create Desktop & Start Menu Shortcuts",
            Checked = true,
            Location = new Point(16, 142),
            AutoSize = true
        };

        _startMenuChk = new CheckBox { Checked = true, Visible = false };

        _launchChk = new CheckBox
        {
            Text = "Launch Copilot Remote Agent Control Center when finished",
            Checked = true,
            Location = new Point(16, 170),
            AutoSize = true
        };

        startupPanel.Controls.Add(_autoStartLoginChk);
        startupPanel.Controls.Add(_updateAutoSignInChk);
        startupPanel.Controls.Add(_autoAppsChk);
        startupPanel.Controls.Add(_firewallChk);
        startupPanel.Controls.Add(_desktopChk);
        startupPanel.Controls.Add(_launchChk);

        // Section 3: Multi-Machine Peer Hub Join
        var peerPanel = CreateSectionPanel("3. Link to Primary Desktop WAN Hub (Exposes This Machine on WAN Automatically)", new Point(22, 512), new Size(582, 82));

        var peerHint = new Label
        {
            Text = "Paste your Primary Desktop's Pairing URL (it will reverse-proxy WAN traffic to this machine over LAN):",
            Location = new Point(14, 26),
            AutoSize = true,
            Font = new Font("Segoe UI", 8.5f),
            ForeColor = Color.FromArgb(139, 148, 158)
        };

        _peerHubUrlBox = new TextBox
        {
            PlaceholderText = "http://192.168.1.100:4321/?token=... or https://.../?token=...",
            Location = new Point(16, 48),
            Size = new Size(544, 25),
            BackColor = Color.FromArgb(13, 17, 23),
            ForeColor = Color.FromArgb(230, 237, 243),
            BorderStyle = BorderStyle.FixedSingle
        };

        peerPanel.Controls.Add(peerHint);
        peerPanel.Controls.Add(_peerHubUrlBox);

        _statusLabel = new Label
        {
            Text = "",
            Location = new Point(24, 612),
            AutoSize = true,
            ForeColor = Color.FromArgb(63, 185, 80)
        };

        var installBtn = new Button
        {
            Text = "Apply & Install",
            Location = new Point(354, 606),
            Size = new Size(146, 38),
            BackColor = Color.FromArgb(35, 134, 54),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            Cursor = Cursors.Hand
        };

        var cancelBtn = new Button
        {
            Text = "Cancel",
            Location = new Point(508, 606),
            Size = new Size(96, 38),
            BackColor = Color.FromArgb(33, 38, 45),
            ForeColor = Color.FromArgb(230, 237, 243),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand
        };

        installBtn.Click += (_, _) =>
        {
            installBtn.Enabled = false;
            string wanMode = _wanCustomRadio.Checked ? "custom" : (_wanLanRadio.Checked ? "lan" : "cloudflare");
            var opts = new InstallOptions
            {
                WanMode = wanMode,
                CustomWanUrl = _customWanUrlBox.Text.Trim(),
                AutoStartLogin = _autoStartLoginChk.Checked,
                EnableUpdateAutoSignIn = _updateAutoSignInChk.Checked,
                AutoLaunchCopilotDesktop = _autoAppsChk.Checked,
                ConfigureFirewall = _firewallChk.Checked,
                CreateDesktopShortcut = _desktopChk.Checked,
                CreateStartMenuShortcut = _desktopChk.Checked,
                PeerPairingUrl = _peerHubUrlBox.Text.Trim(),
                LaunchNow = _launchChk.Checked
            };

            string dest = SetupProgram.PerformInstall(opts);
            _statusLabel.Text = $"✅ Installed & configured in {dest}";
            MessageBox.Show(
                $"Copilot Remote Agent has been installed and configured!\n\nLocation: {dest}\nWAN Mode: {wanMode.ToUpperInvariant()}\nWindows Auto-Start: {(opts.AutoStartLogin ? "Enabled" : "Disabled")}\nCompanion Apps Auto-Launch: {(opts.AutoLaunchCopilotDesktop ? "Enabled" : "Disabled")}",
                "Setup Complete",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
            Close();
        };

        cancelBtn.Click += (_, _) => Close();

        Controls.Add(title);
        Controls.Add(sub);
        Controls.Add(wanPanel);
        Controls.Add(startupPanel);
        Controls.Add(peerPanel);
        Controls.Add(_statusLabel);
        Controls.Add(installBtn);
        Controls.Add(cancelBtn);
    }

    private static Panel CreateSectionPanel(string heading, Point location, Size size)
    {
        var panel = new Panel
        {
            Location = location,
            Size = size,
            BackColor = Color.FromArgb(22, 27, 34),
            BorderStyle = BorderStyle.FixedSingle
        };
        var lbl = new Label
        {
            Text = heading,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(88, 166, 255),
            Location = new Point(12, 7),
            AutoSize = true
        };
        panel.Controls.Add(lbl);
        return panel;
    }
}
