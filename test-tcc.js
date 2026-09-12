const { systemPreferences } = require("electron");
console.log("MediaAccessStatus screen:", systemPreferences.getMediaAccessStatus ? systemPreferences.getMediaAccessStatus("screen") : "n/a");
console.log("TrustedAccessibility:", systemPreferences.isTrustedAccessibilityClient ? systemPreferences.isTrustedAccessibilityClient(false) : "n/a");
