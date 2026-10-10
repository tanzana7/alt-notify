import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const analyticsSource = fs.readFileSync(path.join(root, "site", "analytics.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
const configSource = fs.readFileSync(path.join(root, "site", "analytics-config.js"), "utf8");

function loadAnalytics({ measurementId = "", hostname = "alt-notify.pages.dev", protocol = "https:" } = {}) {
  const appendedScripts = [];
  const listeners = {};
  const document = {
    head: { appendChild(script) { appendedScripts.push(script); if (script.onload) script.onload(); } },
    createElement() { return {}; },
    addEventListener(name, listener) { listeners[name] = listener; }
  };
  const window = {
    location: { hostname, protocol },
    ALT_NOTIFY_ANALYTICS: { measurementId }
  };
  const context = { window, document, encodeURIComponent };
  vm.runInNewContext(analyticsSource, context);
  return { window, document, appendedScripts, listeners };
}

describe("GA4 foundation", () => {
  it("does not create Google state or load a script when the ID is empty", () => {
    const result = loadAnalytics();
    assert.equal(result.appendedScripts.length, 0);
    assert.equal("dataLayer" in result.window, false);
  });

  it("rejects placeholder and malformed IDs", () => {
    for (const measurementId of ["G-XXXXXXXXXX", "UA-123456", "not-an-id"]) {
      const result = loadAnalytics({ measurementId });
      assert.equal(result.appendedScripts.length, 0, measurementId);
    }
  });

  it("does not load on localhost, file URLs, or other hosts", () => {
    for (const options of [{ hostname: "localhost" }, { hostname: "127.0.0.1" }, { hostname: "alt-notify.pages.dev", protocol: "file:" }, { hostname: "preview.alt-notify.pages.dev" }]) {
      const result = loadAnalytics({ ...options, measurementId: "G-ABC1234567" });
      assert.equal(result.appendedScripts.length, 0, JSON.stringify(options));
    }
  });

  it("initializes only on the production host without making a real request in the test", () => {
    const result = loadAnalytics({ measurementId: "G-ABC1234567" });
    assert.equal(result.appendedScripts.length, 1);
    assert.equal(result.appendedScripts[0].src, "https://www.googletagmanager.com/gtag/js?id=G-ABC1234567");
    assert.equal(result.window.dataLayer.length, 2);
    assert.equal(typeof result.window.gtag, "function");
  });

  it("tracks only allowlisted events with a safe location parameter", () => {
    const result = loadAnalytics({ measurementId: "G-ABC1234567" });
    const calls = result.window.dataLayer;
    result.window.AltNotifyAnalytics.trackEvent("bot_invite_click", { location: "hero", userId: "discord-user" });
    result.window.AltNotifyAnalytics.trackEvent("bot_invite_click", { location: "attacker", guildId: "guild" });
    result.window.AltNotifyAnalytics.trackEvent("unknown_event", { location: "hero" });
    assert.equal(calls.length, 4);
    // The loader runs in a VM realm, so normalize its arguments before comparing prototypes.
    assert.deepEqual(JSON.parse(JSON.stringify(Array.from(calls[2]))), ["event", "bot_invite_click", { location: "hero" }]);
    assert.deepEqual(JSON.parse(JSON.stringify(Array.from(calls[3]))), ["event", "bot_invite_click", {}]);
    assert.equal(calls.some((call) => JSON.stringify(call).includes("discord-user")), false);
    assert.equal(calls.some((call) => JSON.stringify(call).includes("guild")), false);
  });

  it("does not throw on disabled clicks and has all required markers", () => {
    const result = loadAnalytics();
    assert.doesNotThrow(() => result.listeners.click({ target: { closest: () => ({ dataset: { analyticsEvent: "bot_invite_click", analyticsLocation: "hero" } }) } }));
    for (const marker of ["bot_invite_click", "github_click", "privacy_click", "terms_click"]) assert.match(indexSource, new RegExp(`data-analytics-event="${marker}"`));
    assert.match(indexSource, /<script defer src="\/analytics-config\.js"><\/script>\s*<script defer src="\/analytics\.js"><\/script>/);
    assert.doesNotMatch(indexSource, /googletagmanager\.com/);
    assert.equal(configSource.match(/measurementId:\s*""/)?.[0], "measurementId: \"\"");
  });

  it("does not contain Discord identity fields or message contents in the analytics implementation", () => {
    assert.doesNotMatch(analyticsSource, /userId|guildId|channelId|messageId|username|client_id|message content|messageContent/i);
  });
});
