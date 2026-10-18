import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
const robotsSource = fs.readFileSync(path.join(root, "site", "robots.txt"), "utf8");
const image = fs.readFileSync(path.join(root, "site", "og-card.png"));

function metadata(nameOrProperty) {
  const escaped = nameOrProperty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta\\s+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, "i");
  return indexSource.match(pattern)?.[1] ?? null;
}

describe("X link preview assets", () => {
  it("publishes crawlable robots rules", () => {
    assert.match(robotsSource, /^User-agent: Twitterbot\r?\nAllow: \/\r?\n/m);
    assert.match(robotsSource, /^User-agent: \*\r?\nAllow: \/\r?\n/m);
  });

  it("keeps the absolute summary-large-image metadata", () => {
    assert.equal(metadata("og:type"), "website");
    assert.equal(metadata("og:image"), "https://alt-notify.pages.dev/og-card.png");
    assert.equal(metadata("og:image:width"), "1200");
    assert.equal(metadata("og:image:height"), "630");
    assert.equal(metadata("twitter:card"), "summary_large_image");
    assert.equal(metadata("twitter:image"), "https://alt-notify.pages.dev/og-card.png");
  });

  it("keeps the card as a valid 1200x630 PNG", () => {
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), 1200);
    assert.equal(image.readUInt32BE(20), 630);
    assert.ok(image.length > 0);
  });
});
