import { verifyAudioAssets, AUDIO_MODEL } from "./audio-assets.ts";
import { normalizeAudioTranscript } from "./audio-transcript.ts";
import { AUDIO_TARGET_RATE, checkAudioParameters } from "./audio-limits.ts";
import type { AudioProgress } from "./audio-progress.ts";

export async function recognizeAudio(
  samples: Float32Array,
  onProgress?: AudioProgress,
) {
  checkAudioParameters(AUDIO_TARGET_RATE, 1, samples.length);
  let energy = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample))
      throw new Error("Audio contains nonfinite samples.");
    energy += sample * sample;
  }
  // Whisper can hallucinate words on silence. This energy gate rejects silent
  // or very quiet audio; it is not a voice-activity or speech-quality detector.
  if (Math.sqrt(energy / samples.length) < 0.0001)
    throw new Error(
      "Audio is silent or too quiet to transcribe. Use a clearer recording.",
    );
  onProgress?.("loading_model");
  const { localModelPath } = await verifyAudioAssets();
  const { env, pipeline, TextStreamer } =
    await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = localModelPath + "/";
  env.useFSCache = false;
  env.useBrowserCache = false;
  // Each extraction runs in a dedicated Worker. No process-global model cache
  // survives its termination, and native inference uses one CPU thread.
  const transcriber = await pipeline(
    "automatic-speech-recognition",
    AUDIO_MODEL,
    {
      device: "cpu",
      dtype: "q8",
      local_files_only: true,
      session_options: {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        executionMode: "sequential",
        enableCpuMemArena: false,
        enableMemPattern: false,
        logSeverityLevel: 4,
      },
    },
  ).catch(() => {
    throw new Error(
      "The local transcription engine could not load. Reinstall the locked dependencies and verify audio model setup.",
    );
  });
  class TokenBudget extends TextStreamer {
    count = 0;
    reported = false;
    constructor() {
      super(transcriber.tokenizer, {
        skip_prompt: true,
        callback_function: () => {},
        token_callback_function: (tokens) => {
          if (!this.reported) {
            this.reported = true;
            onProgress?.("recognizing");
          }
          this.count += tokens.length;
          if (this.count >= 448)
            throw new Error(
              "A transcription window reached its token limit. Nothing was imported; split the recording into shorter parts.",
            );
        },
      });
    }
    end() {
      super.end();
      this.count = 0;
    }
  }
  try {
    const result = await transcriber(samples, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      max_new_tokens: 448,
      do_sample: false,
      num_beams: 1,
      streamer: new TokenBudget(),
    });
    onProgress?.("validating");
    return normalizeAudioTranscript(result, samples.length / AUDIO_TARGET_RATE);
  } catch (error) {
    // Native diagnostics may include generated/source fragments. Known local
    // validation errors are useful; provider/decoder messages are not public.
    if (
      error instanceof Error &&
      /^(Transcription returned|Transcript segments|A transcription window|Unexpected transcription batch)/.test(
        error.message,
      )
    )
      throw error;
    throw new Error(
      "Local audio transcription failed. Nothing was imported; try a clearer or shorter English recording.",
    );
  } finally {
    await transcriber.dispose().catch(() => {
      throw new Error("The local transcription engine failed to close.");
    });
  }
}
