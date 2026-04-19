import { describe, expect, it } from "vitest";
import { SENSITIVE_PATTERNS, checkPath, refusalMessage } from "./file-upload-denylist.js";

describe("file-upload-denylist — must BLOCK", () => {
  const attackPaths: string[] = [
    // SSH keys — both separator styles
    String.raw`C:\Users\fix\.ssh\id_rsa`,
    "C:/Users/fix/.ssh/id_rsa",
    "id_rsa.bak",
    "/home/fix/id_ed25519",

    // Chromium-family profile stores (Cookies, Login Data, History...)
    "C:/Users/fix/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Cookies",
    "C:/Users/fix/AppData/Local/Google/Chrome/User Data/Default/Login Data",
    "C:/Users/fix/AppData/Local/Microsoft/Edge/User Data/Default/History",

    // Unix password files
    "/etc/passwd.bak",

    // macOS credential / vault stores
    "/Users/fix/Library/Keychains/login.keychain-db",
    "/Users/fix/Library/Application Support/1Password/Data/vault.sqlite",

    // Firefox / Thunderbird
    "/home/fix/.mozilla/firefox/abc.default/cookies.sqlite",
    "/home/fix/.mozilla/firefox/abc.default/logins.json",

    // AWS / Cloud SDKs
    "/home/fix/.aws/credentials",
    "/home/fix/.config/gcloud/access_tokens.db",

    // Credential-keyword filenames
    "my_passwords.txt",
    "hashed-credentials.csv",

    // Certificate / key file extensions (substring attacks)
    "server.pem",
    "certificate.pem.txt",

    // Wallet / vault keywords
    "wallet.dat",

    // UNC / WSL paths
    String.raw`\\wsl$\Ubuntu\home\fix\.ssh\id_rsa`,
    "//server/share/secrets.txt",

    // This extension's own config
    "C:/Users/fix/.claude-companion/config.json",
  ];

  it.each(attackPaths)("blocks: %s", (path) => {
    const r = checkPath(path);
    expect(r.blocked).toBe(true);
    expect(r.matchedPattern).toBeInstanceOf(RegExp);
  });
});

describe("file-upload-denylist — must ALLOW", () => {
  const benignPaths: string[] = [
    "C:/Users/fix/Downloads/resume.pdf",
    "C:/Users/fix/Documents/report.docx",
    "/tmp/image.png",
    String.raw`C:\Users\fix\Pictures\photo.jpg`,
    "/Users/fix/Desktop/notes.md",
    "C:/Users/fix/Documents/my notes.txt",
    "proposal-v2.pdf",
    "logo.svg",
    // User landing a Word recovery doc into an upload is legit
    "C:/Users/fix/AppData/Local/Microsoft/Word/Recover/draft.docx",
  ];

  it.each(benignPaths)("allows: %s", (path) => {
    const r = checkPath(path);
    expect(r.blocked).toBe(false);
    expect(r.matchedPattern).toBeUndefined();
  });
});

describe("refusalMessage", () => {
  it("returns null for benign paths", () => {
    expect(refusalMessage("/tmp/image.png")).toBeNull();
  });

  it("returns a descriptive message for blocked paths", () => {
    const msg = refusalMessage(String.raw`C:\Users\fix\.ssh\id_rsa`);
    expect(msg).not.toBeNull();
    expect(msg).toContain("refused to upload");
    expect(msg).toContain(String.raw`C:\Users\fix\.ssh\id_rsa`);
    expect(msg).toContain("rename or move");
  });
});

describe("SENSITIVE_PATTERNS export sanity", () => {
  it("exposes all 14 patterns", () => {
    expect(SENSITIVE_PATTERNS).toHaveLength(14);
  });

  it("every entry is a RegExp", () => {
    for (const p of SENSITIVE_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
