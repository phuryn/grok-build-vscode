const { systemPreferences } = require("electron");
console.log("screen:", systemPreferences.getMediaAccessStatus("screen"));
console.log("accessibility:", systemPreferences.isTrustedAccessibilityClient(false));
