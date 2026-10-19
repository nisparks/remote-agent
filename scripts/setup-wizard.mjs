#!/usr/bin/env node
/**
 * Copilot Remote Agent — Interactive Setup & Multi-Machine Join Wizard
 *
 * Usage:
 *   npm run setup                          # Interactive first-run onboarding wizard
 *   npm run join -- <primary-pairing-url>  # One-command bi-directional peer registration
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";

const COPILOT_HOME = path.join(os.homedir(), ".copilot");
const WAN_CONFIG_PATH = path.join(COPILOT_HOME, "remote-agent-wan.json");
const AUTH_CONFIG_PATH = path.join(COPILOT_HOME, "remote-agent-auth.json");

function getLocalLanUrl(port = 4321) {
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const lower = name.toLowerCase();
      if (lower.includes("wsl") || lower.includes("vethernet") || lower.includes("docker")) continue;
      if (!addr.address.startsWith("100.")) {
        return `http://${addr.address}:${port}`;
      }
    }
  }
  return `http://localhost:${port}`;
}

function getLocalToken() {
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, "utf8"));
      return parsed.pairingToken || "";
    }
  } catch {}
  return "";
}

async function joinPeerHub(targetPairingUrl, localPort = 4321) {
  let cleanUrl = targetPairingUrl.trim();
  let token = "";
  if (cleanUrl.includes("?token=")) {
    const [base, q] = cleanUrl.split("?token=");
    cleanUrl = base.replace(/\/+$/, "");
    token = decodeURIComponent((q || "").split("&")[0]);
  } else {
    cleanUrl = cleanUrl.replace(/\/+$/, "");
  }

  console.log(`\n🔗 Linking this machine (${os.hostname()}) with Peer Hub: ${cleanUrl}...`);
  const localUrl = `http://127.0.0.1:${localPort}`;
  const localToken = getLocalToken();

  // 1. Tell our local running server (if up) to register the remote peer (which also does a reciprocal registration!)
  try {
    const res = await fetch(`${localUrl}/api/peers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(localToken ? { Authorization: `Bearer ${localToken}` } : {}),
      },
      body: JSON.stringify({
        pairingUrl: targetPairingUrl.trim(),
        token,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`✅ Linked bi-directionally! Registered peers: ${data.peers.map((p) => p.name).join(", ")}`);
      return;
    }
  } catch {
    // Local server not running yet; register directly against the remote hub
  }

  // 2. Direct registration against the remote hub
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${cleanUrl}/api/peers`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: os.hostname(),
      lanUrl: getLocalLanUrl(localPort),
      token: localToken || undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`Remote hub returned HTTP ${res.status}`);
  }
  console.log(`✅ Registered ${os.hostname()} with ${cleanUrl}!`);
}

async function main() {
  const args = process.argv.slice(2);
  const joinIdx = args.indexOf("--join");
  if (joinIdx !== -1 && args[joinIdx + 1]) {
    await joinPeerHub(args[joinIdx + 1]);
    return;
  }
  if (args[0] && (args[0].startsWith("http://") || args[0].startsWith("https://"))) {
    await joinPeerHub(args[0]);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n==============================================================");
  console.log("  🚀 Copilot Remote Agent — First-Run Setup Wizard");
  console.log("==============================================================\n");

  console.log("How would you like to connect from outside your home Wi-Fi (WAN)?");
  console.log("  [1] Zero-Config Cloudflare HTTPS Tunnel (Free — no router/DDNS needed; note: URL rotates if PC reboots while away)");
  console.log("  [2] Tailscale VPN (Uses your permanent 100.x.y.z Tailscale address — zero router rules needed)");
  console.log("  [3] Custom Domain / Dynamic DNS + Router Port Forward (Permanent URL; requires forwarding TCP 4321 -> this PC on router + Hairpin NAT)");
  console.log("  [4] LAN Only / Secondary Desktop (Home Wi-Fi only, or piggyback on a Primary Desktop WAN Hub in the next step)\n");

  const choice = (await rl.question("Select option [1-4] (default: 1): ")).trim() || "1";
  fs.mkdirSync(COPILOT_HOME, { recursive: true });

  if (choice === "1") {
    fs.writeFileSync(WAN_CONFIG_PATH, JSON.stringify({ autoStart: true, customWanUrl: null }, null, 2));
    console.log("✅ Configured Zero-Config Cloudflare HTTPS WAN Tunnel (downloads cloudflared on demand).");
    console.log("   ℹ️  Tip: While on home Wi-Fi, your phone auto-syncs the latest tunnel URL. For a permanent URL across unattended reboots, use Option 2 (Tailscale) or Option 3 (Custom DDNS).");
  } else if (choice === "2") {
    fs.writeFileSync(WAN_CONFIG_PATH, JSON.stringify({ autoStart: false, customWanUrl: null }, null, 2));
    console.log("✅ Configured Tailscale / LAN mode (Tailscale 100.x.y.z IPs are auto-detected and permanent across reboots).");
  } else if (choice === "3") {
    console.log("\n📋 Router Port-Forwarding & TLS Checklist for Custom Domain / Dynamic DNS:");
    console.log("   1. Forward external TCP Port 4321 -> this PC's LAN IP (Port 4321) on your router.");
    console.log("   2. Enable 'Hairpin NAT' (NAT Loopback) on your router so the https:// WAN URL also works when you are on home Wi-Fi.");
    console.log("   3. Check 'Allow LAN Firewall' in the Desktop app (or run `start-remote-agent.ps1 -OpenFirewall`) to allow TCP 4321 in Windows Firewall.");
    console.log("   4. Place your Let's Encrypt fullchain (`cert.pem`) and private key (`key.pem`) in ~/.copilot/tls/ (or a fallback TLS cert is generated automatically).\n");
    const customUrl = (await rl.question("Enter your Custom HTTPS WAN URL (e.g. https://remote.example.com:4321): ")).trim();
    fs.writeFileSync(WAN_CONFIG_PATH, JSON.stringify({ autoStart: false, customWanUrl: customUrl || null }, null, 2));
    console.log(`✅ Saved Custom WAN URL: ${customUrl}`);
  } else {
    fs.writeFileSync(WAN_CONFIG_PATH, JSON.stringify({ autoStart: false, customWanUrl: null }, null, 2));
    console.log("✅ Configured LAN / Secondary Desktop mode (link to a Primary Desktop below to share its WAN access with zero router rules).");
  }

  if (process.platform === "win32") {
    const autoAns = (await rl.question("\nEnable Windows Auto-Start & Unattended Update Reboot Recovery? [Y/n]: ")).trim().toLowerCase();
    if (autoAns !== "n") {
      try {
        const repoRoot = process.cwd();
        const exePath = path.join(repoRoot, "releases", "desktop-app", "RemoteAgentDesktop.exe");
        execFileSync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'CopilotRemoteAgent' -Value '"\`${exePath}\`" --minimized "\`${repoRoot}\`"'; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name 'RestartApps' -Value 1 -Type DWord -ErrorAction SilentlyContinue`,
        ]);
        console.log("✅ Enabled Windows Login Auto-Start & Winlogon RestartApps.");
      } catch (err) {
        console.log("⚠️ Could not set registry key:", err.message);
      }
    }
  }

  const peerAns = (await rl.question("\nLink this machine to an existing Remote Agent Desktop/Server? Paste its Pairing URL (or press Enter to skip): ")).trim();
  if (peerAns) {
    await joinPeerHub(peerAns);
  }

  rl.close();
  console.log("\n🎉 Setup complete! Run `npm start` (or launch `releases\\RemoteAgentDesktop.exe`) to begin.\n");
}

main().catch((err) => {
  console.error("Setup error:", err.message);
  process.exit(1);
});
