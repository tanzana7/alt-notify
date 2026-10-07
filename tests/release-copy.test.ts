import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { helpText } from "../src/help.js";

// These are current user-facing surfaces. Historical beta records (Changelog,
// acceptance evidence) are intentionally excluded so release history stays intact.
const currentCopy = [
  "README.md",
  "docs/BETA_GUIDE.md",
  "docs/STORE_DESCRIPTION.md",
  "docs/TERMS.md",
  "docs/PRIVACY.md",
  "site/index.html",
  "site/terms.html",
  "site/privacy.html"
] as const;

function source(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("v1 user-facing copy", () => {
  it.each(currentCopy)("does not present %s as a beta or advertise Pro", (file) => {
    expect(source(file)).not.toMatch(/Public Beta|公開β|β版|Free Beta|Pro(?:プラン|の課金機能|：|:)/i);
  });

  it("keeps the command copy on the actual Free limit without internal tiers", () => {
    const help = helpText("Alt Notify");
    expect(help).toContain("Freeでは、サブアカウントを1つまで連携できます。");
    expect(help).not.toMatch(/Public Beta|β版|開発者|テスト用|\bPro\b/);
    const statusSource = source("src/index.ts");
    expect(statusSource).toContain("連携数：${status.links.length}/${status.linkLimit ?? 1}");
    expect(statusSource).not.toMatch(/β版Free上限|開発者・テスト用\/Pro/);
  });

  it("keeps package metadata consistent and the public site linked", () => {
    const manifest = JSON.parse(source("package.json")) as { version: string };
    const lock = JSON.parse(source("package-lock.json")) as { version: string; packages: { "": { version: string } } };
    expect(manifest.version).toBe("1.0.0");
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].version).toBe(manifest.version);
    expect(source("site/index.html")).toContain('href="/privacy.html"');
    expect(source("site/index.html")).toContain('href="/terms.html"');
    expect(source("site/index.html")).toContain("discord.com/oauth2/authorize?");
  });
});
