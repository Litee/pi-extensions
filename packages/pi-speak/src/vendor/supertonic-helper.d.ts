/**
 * Type declarations for vendor/supertonic/nodejs/helper.js
 * (Plain ES module — no upstream types exist)
 */

/** An ONNX-backed voice style loaded from JSON files */
export interface Style {
  /** ort.Tensor containing the text-to-latent parameters */
  ttl: unknown;
  /** ort.Tensor containing the duration predictor parameters */
  dp: unknown;
}

/** Result returned by TextToSpeech.call() / TextToSpeech.batch() */
export interface TTSResult {
  /** PCM samples (float32, mono) */
  wav: number[];
  /**
   * Per-segment durations in seconds.
   * For `call()` this is a single-element array.
   */
  duration: number[];
}

/** Loaded TTS engine instance */
export interface TextToSpeech {
  /** Output sample rate, typically 44100 Hz */
  sampleRate: number;

  /**
   * Synthesise a single utterance.
   *
   * @param text          Input text
   * @param lang          BCP-47 language tag (e.g. "en", "ko", "ja")
   * @param style         Voice style loaded by loadVoiceStyle()
   * @param totalStep     Diffusion steps (default: 8)
   * @param speed         Speaking rate multiplier (default: 1.05)
   * @param silenceDuration Silence padding in seconds (default: 0.3)
   */
  call(
    text: string,
    lang: string,
    style: Style,
    totalStep?: number,
    speed?: number,
    silenceDuration?: number,
  ): Promise<TTSResult>;

  /**
   * Synthesise a batch of utterances in a single forward pass.
   *
   * @param textList  Array of input texts
   * @param langList  Array of language tags, one per text
   * @param style     Voice style loaded by loadVoiceStyle()
   * @param totalStep Diffusion steps (default: 8)
   * @param speed     Speaking rate multiplier (default: 1.05)
   */
  batch(
    textList: string[],
    langList: string[],
    style: Style,
    totalStep?: number,
    speed?: number,
  ): Promise<TTSResult>;
}

/**
 * Load the TTS engine from a directory containing ONNX model files.
 *
 * @param onnxDir  Path to the directory that holds the *.onnx model files
 * @param useGpu   Whether to use GPU execution (default: false)
 */
export function loadTextToSpeech(
  onnxDir: string,
  useGpu?: boolean,
): Promise<TextToSpeech>;

/**
 * Load one or more voice style JSON files and merge them into a Style object.
 *
 * @param voiceStylePaths Array of paths to voice-style *.json files
 * @param verbose         Print loading info to stdout (default: false)
 */
export function loadVoiceStyle(
  voiceStylePaths: string[],
  verbose?: boolean,
): Style;

/**
 * Write PCM samples to a WAV file on disk.
 *
 * @param filename   Destination file path
 * @param audioData  PCM samples as returned by TextToSpeech.call()
 * @param sampleRate Sample rate in Hz (use tts.sampleRate)
 */
export function writeWavFile(
  filename: string,
  audioData: number[],
  sampleRate: number,
): void;
