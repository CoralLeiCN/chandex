import {
  AUDIO_MODEL,
  AUDIO_MODEL_BYTES,
  AUDIO_MODEL_REVISION,
  installAudioAssets,
} from "../src/ingestion/audio-assets.ts";

if (process.argv.length !== 2) {
  console.error(
    "Usage: npm run audio:setup. Set CODEBOOM_AUDIO_MODEL_DIR to choose the local model directory.",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(
      `Installing ${AUDIO_MODEL} @ ${AUDIO_MODEL_REVISION} (${AUDIO_MODEL_BYTES} bytes).`,
    );
    const result = await installAudioAssets({
      progress: (path) => console.log(`Verified ${path}`),
    });
    console.log(
      `${result.installed ? "Installed" : "Already verified"}: ${result.modelPath}`,
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Transcription model setup failed.",
    );
    process.exitCode = 1;
  }
}
