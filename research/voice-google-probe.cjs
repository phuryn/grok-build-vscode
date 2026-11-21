// Run after npm run compile. Accepts mono 16 kHz PCM16 LE (.pcm or .wav).
const { readFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { createPcmVoiceStreamer } = require("../out/voice-streamer.js");
const { GOOGLE_PCM_CHUNK_BYTES, pcmFromGoogleVoiceWav } = require("../out/google-voice.js");
const { buildSttKeyterms, DEFAULT_SEND_PHRASE, MAX_RECORDING_SECONDS } = require("../out/voice.js");

async function main() {
  const key = process.env.GEMINI_API_KEY?.trim();
  const file = process.argv[2];
  if (!key || !file) throw new Error("Set GEMINI_API_KEY and pass a mono 16 kHz PCM16 LE .wav or .pcm file.");
  const bytes = readFileSync(file);
  const pcm = /\.wav$/i.test(file) ? pcmFromGoogleVoiceWav(bytes) : bytes;
  if (!pcm.length || pcm.length % 2 || pcm.length > 32000 * MAX_RECORDING_SECONDS) {
    throw new Error(`Use a non-empty PCM16 recording up to ${MAX_RECORDING_SECONDS} seconds.`);
  }

  const stream = createPcmVoiceStreamer("google");
  let error;
  stream.on("partial", ({ text, speechFinal }) => console.log(speechFinal ? "[Final so far]" : "[Interim]", text));
  stream.on("error", err => { error = err; });
  try {
    await stream.start({ apiKey: key, keyterms: buildSttKeyterms(DEFAULT_SEND_PHRASE, []), log: console.error });
    for (let offset = 0; offset < pcm.length; offset += GOOGLE_PCM_CHUNK_BYTES) {
      if (!stream.writePcm(pcm.subarray(offset, offset + GOOGLE_PCM_CHUNK_BYTES))) {
        throw error || new Error("The stream closed before the audio was sent.");
      }
      await delay(100);
      if (error) throw error;
    }
    console.log("[Final]", await stream.stop());
  } finally {
    stream.cancel();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
