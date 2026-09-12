const { systemPreferences } = require("electron");
console.log(systemPreferences.getMediaAccessStatus ? systemPreferences.getMediaAccessStatus("screen") : "N/A");
