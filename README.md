# Copilot Remote Agent (`remote-agent`)

**Native Android & Web Companion for Desktop GitHub Copilot Sessions**

Monitor, inspect (high-res images, 3D `.stl` meshes, Markdown docs, and Git diffs), annotate, and steer all of your running **Desktop GitHub Copilot** sessions (`github.exe` Desktop App & `@github/copilot-sdk` CLI sessions) from your **Android Phone**, **Chromebook**, or **Secondary Laptop**—while keeping all execution, local toolchains, and configured Desktop MCP servers (`~/.copilot/mcp-config.json`, local Git worktrees) running natively on your Desktop.

---

## 🌟 Highlights & Capabilities

| Feature | What It Does |
| :--- | :--- |
| **🔌 Live Desktop App & SDK Bridge** | Connects directly to the GitHub Copilot Desktop App's local WebSocket bus (`~/.copilot/run/ws.port` & `ws.token`) and `@github/copilot-sdk` (`CopilotClient`). Dynamically discovers your configured MCP servers from `~/.copilot/mcp-config.json` and streams live tokens, reasoning traces, tool executions, and MCP calls in real time. |
| **🔍 Transparent Native CLI Step Stream** | Mirrors the native GitHub Copilot CLI/Desktop timeline with borderless `💭 Thought`, `>_` shell, `TS`/`JS`/`PY` file view/edit, and `MCP` rows. Toggle between **Trace: Smart** (active turn expanded, older multi-step batches folded) and **Trace: Full** with 1 tap. |
| **📜 Smart Sticky Auto-Scroll** | Automatically scrolls as new tokens and tool steps stream in when you are at the bottom; pauses auto-scroll the moment you scroll up to read history and shows a floating **`↓ Latest activity`** button. |
| **⏳ Queued Steering Visibility** | Prompts sent while a session is busy (`Immediate Steer` or `Queue for Next Turn`) appear immediately in the stream as **`You • ⏳ QUEUED STEERING • WILL ADMIT AT NEXT STEP`** until admitted by the Desktop agent. |
| **🖼️ Pinch-to-Zoom Lightbox & Touch Markup Studio** | Tap any image or CAD render to open in **🔍 Zoom / Pan Mode** (2-finger pinch-zoom up to `8×`, 1-finger pan, double-tap `2.5×`). Tap **`✏️ Annotate`** to draw freehand redlines and send the annotated PNG straight into the active Copilot session. |
| **🧊 Interactive 3D `.stl` CAD Viewer** | Built-in binary & ASCII `.stl` mesh parser with 60fps touch orbit, pinch-to-zoom, pan, wireframe toggle, and 1-tap 3D snapshot annotation. |
| **📲 1-Tap Over-The-Air `.apk` / `.exe` Updates** | Automatically indexes build outputs (`releases/`, `app/build/outputs/apk/`) per session and renders **`⬇ INSTALL APK`** cards inline in chat and in the Artifacts tab. |
| **🎛️ Full Model, Reasoning & Context Control** | The composer's model picker mirrors the desktop app's own: the models, Auto levels (`Standard` / `High` / `Max`), reasoning efforts, and long-context windows come live from the desktop app for each session (`GET /api/sessions/:id/models`), so new models appear without an update. Switch them, plus Execution Mode (`Interactive`, `Plan`, `Autopilot`), from the mobile composer bar (`POST /api/sessions/:id/config`). |
| **📊 Monthly Copilot Quota & Session Telemetry** | Displays live monthly GitHub Copilot Premium Interactions quota (`% remaining`, used vs. entitlement, reset date) and per-session token/AIU breakdown in the **Plan & Quota** tab, drawer, and status bar. |
| **🔄 Live UI Hot-Reload & Cache-Busting** | Automatically versions `/styles.css` and `/app.js` by content SHA-1 (`?v=<uiVersion>`) and broadcasts `ui_reload` over WebSocket whenever `src/public/*` changes, plus a 1-tap `↻` Reload button in the mobile top bar. |
| **🔐 Rolling 6-Digit MFA & 1-Tap Phone Push Login** | Temporarily pair any new desktop, laptop, or Chromebook on LAN or WAN without typing a long token: enter the **6-digit RFC 6238 TOTP code** (from your paired Android app or **Google / Microsoft Authenticator**), **or** click **Request 1-Tap Approval on Paired Phone** to approve a time-limited session (`1h`, `8h`, `24h`, `30d`) with 1 tap on your phone. |
| **🖥️ Multi-Desktop & Multi-Account Switcher** | Control multiple workstations or servers (e.g., primary Windows CAD desktop + 64-core build/inference server) across multiple GitHub accounts (`@account` badges) from a single header bar. |
| **🔒 Single-Port HTTP + Let's Encrypt HTTPS** | Multiplexes both `http://` (`ws://`) and `https://` (`wss://`) on port `4321` via first-byte TLS inspection (`src/tls.ts`), supporting both local LAN Wi-Fi and encrypted WAN access. |

---

## ⚡ 5-Minute Onboarding Guide

### Prerequisites
- **Windows 10/11 Desktop** with [GitHub Copilot Desktop](https://github.com/features/copilot) (`github.exe`) installed and signed in.
- **Node.js 22+** (for running the server from source or building).
- *(Optional for rebuilding binaries)*: .NET 8 SDK (`dotnet`) for the Windows Desktop tray app, and Android SDK Build-Tools 33 + JDK 17+ for rebuilding the Android `.apk`.

---

### Step 1: Clone & Start the Desktop Bridge

#### Option A: One-Click Windows Installer or Portable Control Center (No CLI Required)
1. Run the installer or portable app from [`releases/`](./releases):
   ```powershell
   # Install with Desktop & Start Menu shortcuts:
   .\releases\RemoteAgent-Desktop-Setup.exe

   # Or run the standalone Control Center + System Tray app directly:
   .\releases\RemoteAgentDesktop.exe
   ```
2. The Windows Control Center automatically starts the bridge server on port `4321` and displays **two side-by-side QR codes**:
   - **Left QR Code**: Pair & authenticate your phone or browser.
   - **Right QR Code**: Download and install `RemoteAgent-android.apk` onto your Android phone.

#### Option B: Run from Terminal (`npm`)
```powershell
git clone https://github.com/nisparks/remote-agent.git
cd remote-agent
npm install

# (Optional) Run the interactive 1-minute onboarding wizard (WAN mode, Windows auto-start, or multi-machine join):
npm run setup

# Start on port 4321 (prints LAN/WAN URLs + scannable ASCII QR code in terminal):
npm start

# Or start with automatic zero-config Cloudflare HTTPS WAN tunnel enabled:
npm run start:wan
```

---

### Step 2: Connect from Your Android Phone, Chromebook, or Another Computer

#### 📱 On Android (Native App or PWA)
1. **Install the Native Android App**:
   - Scan the **Download APK QR Code** in `RemoteAgentDesktop.exe`, **or** open `http://<your-desktop-lan-ip>:4321` in Chrome on your phone, tap the **QR / WAN** button in the top-right, and tap **`🤖 Download Android App (.APK)`**.
2. **Pair & Connect**:
   - Open **Copilot Remote** on your Android phone.
   - Enter your Desktop's LAN URL (e.g. `http://192.168.1.100:4321`) or WAN HTTPS URL and your **Pairing Token** (found in `~/.copilot/remote-agent-auth.json` or the Desktop Control Center), or simply scan the **Pairing QR Code** with your phone's camera!
   - Once paired, your token and last-verified endpoint are persisted on-device for **0ms instant startup** and automatic wake-up reconnection.

#### 💻 On a Chromebook, MacBook, or Secondary PC
No installation is needed—the full companion UI runs in any modern browser:
1. Open the pairing URL shown in the Desktop Control Center or terminal:
   ```text
   https://<your-wan-domain>:4321/?token=<YOUR_PAIRING_TOKEN>
   # or on local Wi-Fi:
   http://<your-desktop-lan-ip>:4321/?token=<YOUR_PAIRING_TOKEN>
   ```
2. The server validates your token, stores an authenticated session cookie + `localStorage` token, and strips `?token=` from the address bar so your URL stays clean.
3. *(Optional)* On Chromebook/Chrome, click the **Install icon (`⊕`)** in the address bar to install **Copilot Remote Agent** as a standalone desktop window.

---

### Step 3: Set Up Remote WAN Access (Control from Anywhere on 5G / LTE)

`remote-agent` supports three WAN modes (all configurable in the GUI Installer `RemoteAgent-Desktop-Setup.exe`, `npm run setup`, or the in-app `⚙️` modal):

| WAN Mode | Router Port Forward Needed? | Permanent Across Unattended Reboots? | Best For |
| :--- | :--- | :--- | :--- |
| **1. Cloudflare Quick Tunnel (`trycloudflare.com`)** | **No** (outbound tunnel) | **No** (URL rotates if PC reboots while away; auto-syncs when on home Wi-Fi) | Instant 1-click testing with zero router/account setup |
| **2. Tailscale / WireGuard VPN (`100.x.y.z`)** | **No** (peer-to-peer mesh) | **Yes** (`100.x.y.z` IP never changes) | Zero-router permanent access across all devices |
| **3. Custom Domain / Dynamic DNS + Port `4321`** | **Yes** (1 rule on router for Primary PC; 0 rules for additional PCs via `/api/peer-proxy`) | **Yes** (permanent domain + Let's Encrypt TLS) | Fastest direct connection with no VPN or third-party tunnel |

#### Path 1: Built-In 1-Click Cloudflare HTTPS Tunnel (Zero Router Setup)
- Select **Zero-Config Cloudflare HTTPS Tunnel** in the installer (or click **Cloudflare Tunnel** in the `⚙️` modal, or run `npm run start:wan`).
- `remote-agent` downloads Cloudflare's official standalone `cloudflared.exe` on demand to `~/.copilot/bin/cloudflared.exe` (nothing is bundled unless enabled) and opens an outbound HTTPS/WSS tunnel.
- *Persistence Note*: Free Quick Tunnels (`*.trycloudflare.com`) require no account, but generate a new URL if the PC reboots while you are away on 5G. (If you have a free Cloudflare account, you can set `"cloudflareTunnelToken"` in `~/.copilot/remote-agent-wan.json` for a permanent subdomain.)

#### Path 2: Custom Domain / Dynamic DNS + Let's Encrypt TLS + Router Port Forwarding (Permanent Direct WAN)
1. **Router Port-Forwarding**: On your router, forward external **TCP port `4321` → `<your-desktop-lan-ip>:4321`**. Reserve that LAN IP in your router's DHCP settings so it never changes.
   - **Dual-NIC backup route (optional):** If your desktop has both Wi-Fi and Ethernet, reserve an IP for each adapter, forward `4321 → <wifi-ip>:4321` and `4322 → <ethernet-ip>:4321`. The Android app automatically falls back to `https://remote.example.com:4322` (WAN port + 1) and to every LAN address the desktop reports, so losing one adapter doesn't drop the connection.
2. **Enable Hairpin NAT (NAT Loopback)**: Enable Hairpin NAT on your router so the exact same `https://remote.example.com:4321` URL works seamlessly whether your phone is on 5G cellular or home Wi-Fi.
3. **Windows Firewall**: Click **🛡️ Allow LAN Firewall** in `RemoteAgentDesktop.exe` (or check the Firewall box in the installer) to allow inbound TCP port `4321`.
4. **TLS Certificate**: Place your Let's Encrypt certificate (`fullchain.pem` → `~/.copilot/tls/cert.pem`) and private key (`privkey.pem` → `~/.copilot/tls/key.pem`) in `~/.copilot/tls/`. *(If none is present, `src/tls.ts` generates a fallback ECDSA certificate on startup.)*
5. Because `src/server.ts` uses a single-port TCP first-byte multiplexer (`0x16` TLS ClientHello → `httpsServer`, otherwise → `httpServer`), **both** `https://remote.example.com:4321` and `http://192.168.1.x:4321` work simultaneously on port `4321`!

#### Path 3: Tailscale / WireGuard Mesh VPN
- Install [Tailscale](https://tailscale.com/) on your Desktop and Android phone.
- `remote-agent` automatically detects `100.x.y.z` Tailscale interfaces and lists them in the Pairing modal with zero router configuration.

---

### Step 4: Controlling Multiple Desktops & Multiple GitHub Accounts

If you run GitHub Copilot across multiple machines (for example, a primary Windows CAD workstation and a secondary desktop or 64-core server, with either the same or different GitHub accounts):
1. Clone and start `remote-agent` on the second machine (`npm start` or `RemoteAgentDesktop.exe`).
2. **Link both machines in one step (Bi-Directional Auto-Discovery)**:
   - **From the CLI on Machine #2**: Run `npm run join -- "<Primary_Machine_Pairing_URL>"`
   - **Or from the Mobile/Web UI**: Open the **Sessions Drawer (`☰`)**, tap **`+ Desktop`**, and paste the second machine's **Pairing URL** (`http://192.168.x.x:4321/?token=...` or `https://.../?token=...`).
3. `remote-agent` automatically queries the second machine's `/api/status`, discovers its hostname, `@github-account`, LAN URL, and WAN URL, and **registers both machines with each other**.
4. **Automatic LAN-to-WAN Hub Reverse Proxy (`/api/peer-proxy/:peerId/*`)**:
   - You only need **one** machine exposed to the WAN (via your router's port `4321` or Cloudflare Tunnel).
   - Every additional desktop or server on your local network can stay on **Local LAN Mode (`http://192.168.x.x:4321`)**: when you tap that machine's pill in the mobile drawer while on 5G WAN, your primary desktop transparently reverse-proxies all API calls, artifacts, images, 3D `.stl` models, and steering prompts to the second desktop over your local network with **zero extra router ports or TLS certs required**.

### Step 5: Auto-Start, Reliability & Unattended Reboot Recovery

1. **Install as an always-on runtime (recommended)**:
   ```powershell
   npm install
   npm run build:desktop
   npm run deploy:local
   ```
   - `deploy:local` copies the bridge to `%LOCALAPPDATA%\CopilotRemoteAgent\runtime`, points the `CopilotRemoteAgent` login entry (`HKCU\...\Run`) at it, and starts the tray app. Running from a stable folder means deleting or archiving a clone/worktree never takes the bridge offline. Re-run it after pulling updates.
2. **One supervisor, no duplicates**:
   - `RemoteAgentDesktop.exe` is the only process that starts the bridge server. It is single-instance, checks `/api/health` every 5 seconds, restarts the server only after ~20 seconds of failed checks (with backoff), and never starts a second server while another process owns port `4321`.
   - When it starts, it also launches `github.exe` (GitHub Copilot Desktop) if it is not already running.
3. **Finish setup: replace old admin servers + sign in after Windows Update restarts (UAC)**:
   - Right-click the tray icon → **`Finish setup: replace old admin server & enable restart sign-in (UAC)...`**, or run `scripts\enable-update-auto-signin.ps1` from an Administrator PowerShell. This removes legacy `CopilotRemoteAgent-*` scheduled tasks (and any orphaned server they started) from older versions that could hold the port or start competing servers, then enables Windows ARSO + `RestartApps` so the tray app (and bridge) come back after unattended reboots.
   - If an older server started with administrator rights is still holding port 4321, the tray app shows a notification; click it and approve the prompt to switch to the updated server.
4. **Diagnosing disconnects**:
   - The server logs startups, crashes, event-loop stalls, and WebSocket connects/disconnects (never tokens) to `~\.copilot\logs\remote-agent-server.log` (rotated at 5 MB).
   - Requests from internet (non-LAN) clients go to `~\.copilot\remote-agent-access.log` (paths only, never tokens), along with connection-level failures that never reach HTTP: TLS handshake errors, secure connections closed without a request, and connections that send nothing. Use it to tell "the phone never reached the desktop" apart from "it connected but something failed".
   - The phone/web app shows a banner while reconnecting and retries with backoff; the Android app prefers the remote HTTPS URL (which also works at home via your router's hairpin NAT) so it does not reload when you move between Wi-Fi and cellular.
   - Some networks (often business or guest Wi-Fi) reset or stall the browser engine's TLS connections while letting other apps through. When the Android app can reach an endpoint but the page fails to load directly (or shows nothing for 15 seconds), or the loaded page's live connection stays down for 20 seconds (or keeps dropping right after connecting), it reloads through a built-in loopback relay (`http://127.0.0.1:47321`) that carries the page over the app's own certificate- and hostname-verified TLS connection. If a relayed load fails, the next attempt goes direct again.
   - Downloads started inside the Android app (for example the **INSTALL APK** artifact card) use Android's download service instead of the browser, so app updates arrive intact on those networks too. They land in **Downloads**; open the file there to install it. Downloads from a home-LAN address still open in the browser.

---

## 📱 Mobile UI & Gesture Reference

- **Portrait-First Header**: Tap the session title at the top of the screen (or `☰`) to open the **Sessions Drawer**, grouped into **Project Folders** (with child/forked sessions indented beneath their parent) and **General Chats**.
- **Stream Tab**:
  - Tap any `💭 Thought`, `>_` shell command, `TS`/`JS` file action, or `MCP` row to inspect full reasoning text, JSON arguments, and command output.
  - Tap **`Trace: Smart / Full`** above the composer to toggle between auto-folding older step batches and expanding every step in the session.
  - Scroll up anytime without losing your place; tap **`↓ Latest activity`** to snap back to the bottom.
- **Image Lightbox & Markup**:
  - Opens in **🔍 Zoom / Pan Mode** by default (2-finger pinch-zoom, 1-finger drag, double-tap `2.5×`).
  - Tap **`✏️ Annotate`** to draw redline feedback on the image and send it directly to Copilot or add it to your Review Queue.
- **Android Back-Swipe Gesture**:
  - Swiping back from the edge of your Android screen cleanly closes any open image lightbox, 3D `.stl` viewer, document viewer, QR modal, or session drawer before exiting the app.
- **Model Picker** (below the composer):
  - Lists exactly what the session can use, grouped like the desktop picker (**Powerful**, **Versatile**, **Lightweight**), with each model's relative cost (`$`–`$$$$`) and any discount.
  - Choose **Auto** to reveal its level picker (**Standard**, **High**, **Max**) when the session's account offers levels. The effort picker shows only the efforts the chosen model supports, and the context picker appears only for models with a long-context window.
  - The level picker shows **Level?** when the desktop app hasn't recorded the session's level (it doesn't record level-only changes); pick a level to set it.
  - Changes made while Copilot is mid-turn are held and shown with a dashed outline; they take effect when the turn ends, and the newest choice wins.
  - Choosing an Auto level while long context is on first switches the current model back to its standard window, because Copilot refuses Auto levels with long context. If the session is busy, both steps run once the turn ends.
  - If the desktop app ever reports that it is "waiting to confirm an earlier model change", that session won't accept changes or messages until the GitHub Copilot app is restarted on the desktop.

---

## 🛠️ Building & Testing from Source

```powershell
# 1. Type-check TypeScript
npm run build

# 2. Rebuild signed Android APK (outputs releases/RemoteAgent-android.apk)
npm run build:apk

# 3. Rebuild Windows Desktop Control Center & Installer (outputs releases/*.exe)
npm run build:desktop

# 4. Run the integration test suite (12 end-to-end tests)
npm test
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for deep technical details on the loopback WebSocket protocol, SQLite schemas, artifact ownership isolation, and multi-tier server offload architecture.
