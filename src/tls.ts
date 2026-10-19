import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TLS_DIR = path.join(os.homedir(), ".copilot", "tls");
const CERT_PATH = path.join(TLS_DIR, "cert.pem");
const KEY_PATH = path.join(TLS_DIR, "key.pem");

export interface TlsCredentials {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
  isLetsEncrypt: boolean;
}

export class TlsManager {
  static ensureCredentials(): TlsCredentials | null {
    try {
      fs.mkdirSync(TLS_DIR, { recursive: true });

      if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
        // Generate fallback self-signed ECDSA P-256 certificate if Let's Encrypt cert is not yet present
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-keyout",
            KEY_PATH,
            "-out",
            CERT_PATH,
            "-days",
            "365",
            "-subj",
            `/CN=${os.hostname().toLowerCase() || "remote-agent.local"}`,
          ],
          { stdio: "ignore" }
        );
      }

      const cert = fs.readFileSync(CERT_PATH, "utf8");
      const key = fs.readFileSync(KEY_PATH, "utf8");
      // Let's Encrypt fullchain has 2+ certificates in the bundle
      const certCount = (cert.match(/-----BEGIN CERTIFICATE-----/g) || []).length;

      return {
        cert,
        key,
        certPath: CERT_PATH,
        keyPath: KEY_PATH,
        isLetsEncrypt: certCount >= 2,
      };
    } catch {
      return null;
    }
  }
}
