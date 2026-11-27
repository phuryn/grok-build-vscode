// An Electron main-process preload for the split-view driver. The real
// sidebar owns the mic and routes every frame. Only the recorder/STT stream
// is replaced, so the test needs no audio device, key, or network.
if (process.type === "browser" && process.env.NODE_ENV === "test") {
  require("../../scripts/smoke-desktop-trace.cjs");
  const { EventEmitter } = require("node:events");
  const voice = require("../../out/voice-streamer.js");
  let stream;
  let canceled = 0;
  class FixtureVoiceStreamer extends EventEmitter {
    transcript = "";
    finalizedTranscript = "";

    async start() { stream = this; }
    async stop() { return this.transcript; }
    cancel() { canceled++; }
  }
  voice.VoiceStreamer = FixtureVoiceStreamer;
  globalThis.splitVoiceFixture = {
    partial(text) {
      if (!stream) throw new Error("The desktop did not start a voice stream");
      stream.transcript = stream.finalizedTranscript = text;
      stream.emit("partial", { text, speechFinal: false });
    },
    canceled: () => canceled,
  };
}
