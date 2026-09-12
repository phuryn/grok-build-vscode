const { systemPreferences } = require("electron");
console.log("systemPreferences screen:", systemPreferences.getMediaAccessStatus ? systemPreferences.getMediaAccessStatus("screen") : "no method");
console.log("systemPreferences accessibility:", systemPreferences.isTrustedAccessibilityClient ? systemPreferences.isTrustedAccessibilityClient(false) : "no method");
