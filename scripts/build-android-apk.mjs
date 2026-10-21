import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const ANDROID_DIR = path.join(ROOT_DIR, "android");
const BUILD_DIR = path.join(ANDROID_DIR, "build");
const RELEASES_DIR = path.join(ROOT_DIR, "releases");
const embedLocal = process.argv.includes("--embed-local");
const OUTPUT_APK = embedLocal
  ? path.join(os.homedir(), ".copilot", "RemoteAgent-paired.apk")
  : path.join(RELEASES_DIR, "RemoteAgent-android.apk");

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const sdkRoot = process.env.ANDROID_HOME || path.join(localAppData, "Android", "Sdk");

const buildToolsDir = path.join(sdkRoot, "build-tools", "33.0.0");
const platformJar = path.join(sdkRoot, "platforms", "android-33", "android.jar");

const aapt2 = path.join(buildToolsDir, "aapt2.exe");
const d8Jar = path.join(buildToolsDir, "lib", "d8.jar");
const zipalign = path.join(buildToolsDir, "zipalign.exe");
const apksignerJar = path.join(buildToolsDir, "lib", "apksigner.jar");

function getLanUrl() {
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const lower = name.toLowerCase();
      if (lower.includes("wsl") || lower.includes("vethernet") || lower.includes("docker")) continue;
      if (!addr.address.startsWith("100.")) {
        return `http://${addr.address}:4321`;
      }
    }
  }
  return "";
}

function getPairingToken() {
  try {
    const authFile = path.join(os.homedir(), ".copilot", "remote-agent-auth.json");
    if (fs.existsSync(authFile)) {
      const parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
      return parsed.pairingToken || "";
    }
  } catch {}
  return "";
}

function getWanUrl() {
  try {
    const wanFile = path.join(os.homedir(), ".copilot", "remote-agent-wan.json");
    if (fs.existsSync(wanFile)) {
      const parsed = JSON.parse(fs.readFileSync(wanFile, "utf8"));
      return parsed.customWanUrl || parsed.lastPublicUrl || "";
    }
  } catch {}
  return "";
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "\\'");
}

console.log("Building Native Android App (RemoteAgent-android.apk)...");

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD_DIR, "compiled_res"), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, "gen"), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, "classes"), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, "dex"), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, "res_merged", "values"), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, "res_merged", "drawable"), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, "res_merged", "drawable-v26"), { recursive: true });
fs.mkdirSync(RELEASES_DIR, { recursive: true });

// 1. Prepare clean generic resources (never embed machine-local tokens or personal DDNS domains in repo APK)
const lanUrl = embedLocal ? getLanUrl() : "";
const token = embedLocal ? getPairingToken() : "";
const wanUrl = embedLocal ? getWanUrl() : "";

const stringsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Copilot Remote</string>
    <string name="default_lan_url">${escapeXml(lanUrl)}</string>
    <string name="default_wan_url">${escapeXml(wanUrl)}</string>
    <string name="default_token">${escapeXml(token)}</string>
</resources>
`;

fs.writeFileSync(path.join(BUILD_DIR, "res_merged", "values", "strings.xml"), stringsXml, "utf8");
for (const f of ["ic_launcher.xml", "ic_launcher_background.xml", "ic_launcher_foreground.xml"]) {
  const srcFile = path.join(ANDROID_DIR, "src", "main", "res", "drawable", f);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, path.join(BUILD_DIR, "res_merged", "drawable", f));
  }
}
const v26File = path.join(ANDROID_DIR, "src", "main", "res", "drawable-v26", "ic_launcher.xml");
if (fs.existsSync(v26File)) {
  fs.copyFileSync(v26File, path.join(BUILD_DIR, "res_merged", "drawable-v26", "ic_launcher.xml"));
}

// 2. aapt2 compile
const resZip = path.join(BUILD_DIR, "compiled_res.zip");
execFileSync(aapt2, [
  "compile",
  "--dir",
  path.join(BUILD_DIR, "res_merged"),
  "-o",
  resZip,
], { stdio: "inherit" });

// 3. aapt2 link
const unalignedApk = path.join(BUILD_DIR, "unaligned.apk");
execFileSync(aapt2, [
  "link",
  "-I",
  platformJar,
  "--manifest",
  path.join(ANDROID_DIR, "src", "main", "AndroidManifest.xml"),
  "--java",
  path.join(BUILD_DIR, "gen"),
  "--min-sdk-version",
  "26",
  "--target-sdk-version",
  "33",
  "-o",
  unalignedApk,
  resZip,
], { stdio: "inherit" });

// 4. javac compile
const rJava = path.join(BUILD_DIR, "gen", "com", "nisparks", "remoteagent", "R.java");
const mainJava = path.join(
  ANDROID_DIR,
  "src",
  "main",
  "java",
  "com",
  "nisparks",
  "remoteagent",
  "MainActivity.java"
);

execFileSync("javac", [
  "-encoding",
  "UTF-8",
  "-source",
  "1.8",
  "-target",
  "1.8",
  "-bootclasspath",
  platformJar,
  "-classpath",
  platformJar,
  "-d",
  path.join(BUILD_DIR, "classes"),
  rJava,
  mainJava,
], { stdio: "inherit" });

// 5. d8 dex compilation
const classFiles = fs
  .readdirSync(path.join(BUILD_DIR, "classes", "com", "nisparks", "remoteagent"))
  .filter((f) => f.endsWith(".class"))
  .map((f) => path.join(BUILD_DIR, "classes", "com", "nisparks", "remoteagent", f));

execFileSync(
  "java",
  [
    "-cp",
    d8Jar,
    "com.android.tools.r8.D8",
    "--lib",
    platformJar,
    "--min-api",
    "26",
    "--output",
    path.join(BUILD_DIR, "dex"),
    ...classFiles,
  ],
  { stdio: "inherit" }
);

// 6. Add classes.dex into unaligned.apk using jar -uf
execFileSync(
  "jar",
  ["-uf", unalignedApk, "-C", path.join(BUILD_DIR, "dex"), "classes.dex"],
  { stdio: "inherit" }
);

// 7. zipalign
const alignedApk = path.join(BUILD_DIR, "aligned.apk");
execFileSync(zipalign, ["-f", "-p", "4", unalignedApk, alignedApk], { stdio: "inherit" });

// 8. Generate signing keystore if not present and sign APK with apksigner
const keystorePath = path.join(ANDROID_DIR, "debug-release.keystore");
if (!fs.existsSync(keystorePath)) {
  execFileSync(
    "keytool",
    [
      "-genkeypair",
      "-v",
      "-keystore",
      keystorePath,
      "-storepass",
      "remoteagent123",
      "-keypass",
      "remoteagent123",
      "-alias",
      "remoteagent",
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      "10000",
      "-dname",
      "CN=Copilot Remote Agent, OU=Engineering, O=nisparks, L=Local, S=NA, C=US",
    ],
    { stdio: "inherit" }
  );
}

execFileSync(
  "java",
  [
    "-jar",
    apksignerJar,
    "sign",
    "--ks",
    keystorePath,
    "--ks-pass",
    "pass:remoteagent123",
    "--key-pass",
    "pass:remoteagent123",
    "--ks-key-alias",
    "remoteagent",
    "--out",
    OUTPUT_APK,
    alignedApk,
  ],
  { stdio: "inherit" }
);

execFileSync("java", ["-jar", apksignerJar, "verify", "--verbose", OUTPUT_APK], {
  stdio: "inherit",
});

// Clean intermediate build artifacts so repo stays clean
fs.rmSync(BUILD_DIR, { recursive: true, force: true });

const stat = fs.statSync(OUTPUT_APK);
console.log(`\n✅ Built and verified signed Android APK: ${OUTPUT_APK} (${(stat.size / 1024).toFixed(1)} KB)`);
