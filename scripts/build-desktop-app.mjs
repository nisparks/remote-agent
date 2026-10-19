import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const RELEASES_DIR = path.join(ROOT_DIR, "releases");
const DESKTOP_OUT_DIR = path.join(RELEASES_DIR, "desktop-app");
const SETUP_OUT_DIR = path.join(RELEASES_DIR, "setup-build");

fs.mkdirSync(DESKTOP_OUT_DIR, { recursive: true });
fs.mkdirSync(SETUP_OUT_DIR, { recursive: true });

console.log("Building Native Windows Desktop App (RemoteAgentDesktop.exe)...");
execFileSync(
  "dotnet",
  [
    "publish",
    path.join(ROOT_DIR, "desktop", "RemoteAgentDesktop.csproj"),
    "-c",
    "Release",
    "-o",
    DESKTOP_OUT_DIR,
    "--nologo",
  ],
  { stdio: "inherit" }
);

// Copy main executable to releases/RemoteAgentDesktop.exe if not currently locked by a running instance
try {
  fs.copyFileSync(
    path.join(DESKTOP_OUT_DIR, "RemoteAgentDesktop.exe"),
    path.join(RELEASES_DIR, "RemoteAgentDesktop.exe")
  );
} catch {
  console.log("Note: releases/RemoteAgentDesktop.exe is currently running; updated releases/desktop-app/RemoteAgentDesktop.exe");
}

console.log("Building Windows Desktop Installer (RemoteAgent-Desktop-Setup.exe)...");
execFileSync(
  "dotnet",
  [
    "publish",
    path.join(ROOT_DIR, "desktop", "Setup", "RemoteAgentSetup.csproj"),
    "-c",
    "Release",
    "-o",
    SETUP_OUT_DIR,
    "--nologo",
  ],
  { stdio: "inherit" }
);

for (const f of fs.readdirSync(SETUP_OUT_DIR)) {
  if (f.startsWith("RemoteAgent-Desktop-Setup")) {
    fs.copyFileSync(path.join(SETUP_OUT_DIR, f), path.join(RELEASES_DIR, f));
  }
}

fs.rmSync(SETUP_OUT_DIR, { recursive: true, force: true });
fs.rmSync(path.join(ROOT_DIR, "desktop", "bin"), { recursive: true, force: true });
fs.rmSync(path.join(ROOT_DIR, "desktop", "obj"), { recursive: true, force: true });
fs.rmSync(path.join(ROOT_DIR, "desktop", "Setup", "bin"), { recursive: true, force: true });
fs.rmSync(path.join(ROOT_DIR, "desktop", "Setup", "obj"), { recursive: true, force: true });

console.log(`✅ Built Windows Desktop App: ${path.join(DESKTOP_OUT_DIR, "RemoteAgentDesktop.exe")}`);
console.log(`✅ Built Windows Installer  : ${path.join(RELEASES_DIR, "RemoteAgent-Desktop-Setup.exe")}`);
