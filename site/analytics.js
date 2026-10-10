(function () {
  "use strict";

  var productionHostnames = new Set(["alt-notify.pages.dev"]);
  var eventLocations = {
    bot_invite_click: new Set(["hero"]),
    github_click: new Set(["footer"]),
    privacy_click: new Set(["footer"]),
    terms_click: new Set(["footer"])
  };
  var measurementId = window.ALT_NOTIFY_ANALYTICS && window.ALT_NOTIFY_ANALYTICS.measurementId;
  var enabled = false;

  function validMeasurementId(value) {
    if (typeof value !== "string") return false;
    var id = value.trim();
    if (!/^G-[A-Z0-9]{6,20}$/i.test(id)) return false;
    return !/^G-(?:X+|0+|YOUR|TEST|EXAMPLE)/i.test(id);
  }

  function productionHost() {
    var location = window.location;
    return Boolean(location && location.protocol === "https:" && productionHostnames.has(String(location.hostname).toLowerCase()));
  }

  function trackEvent(name, params) {
    if (!enabled || typeof window.gtag !== "function" || !Object.prototype.hasOwnProperty.call(eventLocations, name)) return;
    var location = params && typeof params.location === "string" ? params.location : "";
    var allowedLocations = eventLocations[name];
    window.gtag("event", name, allowedLocations.has(location) ? { location: location } : {});
  }

  window.AltNotifyAnalytics = { trackEvent: trackEvent };

  if (document && document.addEventListener) {
    document.addEventListener("click", function (event) {
      var target = event && event.target;
      var link = target && typeof target.closest === "function" ? target.closest("[data-analytics-event]") : null;
      if (!link || !link.dataset) return;
      trackEvent(link.dataset.analyticsEvent, { location: link.dataset.analyticsLocation });
    });
  }

  if (!productionHost() || !validMeasurementId(measurementId)) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", measurementId.trim());

  var script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(measurementId.trim());
  script.onload = function () { enabled = true; };
  document.head.appendChild(script);
}());
