// audioProcessor.ts
import fs from 'fs';
import path from 'path';
import pkg from 'wavefile';
const { WaveFile } = pkg;
import { logger } from './logger.js';
import type { SharedState } from './main_agent.js';
import { mediaEvents } from './emitter.js';
import { setupLiveKitAudioTrack } from './lk_audio.js';
import { randomUUID } from 'crypto';
import { AudioFrame } from '@livekit/rtc-node';

/*
const TARGET_CHUNK_MS = 20; // 20 ms
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const SAMPLES_PER_CHUNK = Math.floor(SAMPLE_RATE * (TARGET_CHUNK_MS / 1000)); // ~960 samples
const BYTES_PER_CHUNK = SAMPLES_PER_CHUNK * 2; // 2 bytes per 16-bit sample (~1920 bytes)
*/
logger.debug("starting recv script")
// Buffer to accumulate incoming processed audio frames
let processedBuffers: Buffer[] = [];
let audiostarted = false;
// EOF marker to signify end of audio stream
const EOF_MARKER = Buffer.from("EOF");
//let pendingBuffer = Buffer.alloc(0);

// Async loop to receive processed audio from Python via ZMQ
export async function receiveProcessedAudio(shared: SharedState): Promise<void>  {
  if (!shared.out_dealer) {
    throw new Error('out_dealer is not initialized.');
  }
  const sessionId = randomUUID();
  shared.audioSessionId = sessionId;
  logger.debug(`session id: ${shared.sessionId}`)
  logger.info(`[AudioProcessor] Started new audio session: ${sessionId}`);
  const { audioSource, audioTrack } = await setupLiveKitAudioTrack(shared);
  shared.audioSource = audioSource;
  shared.audioTrack = audioTrack;
  mediaEvents.emit('processed-audio-started');

  logger.info("[AudioProcessor] Starting to receive processed audio...");

  
  while (true) {
    try {
      // Receives messages: ZeroMQ Dealer sockets directly provide the payload.
      const [msg] = await shared.out_dealer.receive();
      if (shared.audioSessionId !== sessionId) {
        logger.debug('[AudioProcessor] Session mismatch. Dropping frame.');
        continue;
      }
      
      // Check for EOF
      if (msg.equals(EOF_MARKER)) {
        mediaEvents.emit('processed-audio-ended');
        logger.info("[AudioProcessor] EOF received, audio track stopped.");
        break;
      }

      logger.debug(`[AudioProcessor] Received processed frame (${msg.length} bytes).`);

      // Store each received chunk
      processedBuffers.push(msg);
      /*pendingBuffer = Buffer.concat([pendingBuffer, msg]);
      while (pendingBuffer.length >= BYTES_PER_CHUNK) {
        // Extract one chunk
        const chunk = pendingBuffer.slice(0, BYTES_PER_CHUNK);
        // Remove the processed chunk from the pending buffer
        pendingBuffer = pendingBuffer.slice(BYTES_PER_CHUNK);

*/
      const int16samples = new Int16Array(msg.buffer, msg.byteOffset, msg.length / 2);
      logger.debug(`[LiveKit] Capturing frame (20ms chunk): ${int16samples.length} samples`);

      if (!shared.audioSource || !shared.audioTrack) {
        logger.debug("[LiveKit] Audio track not ready — skipping frame.");
        continue;
      }
      logger.debug(`[LiveKit] Capturing frame(int16samples): ${int16samples.length} samples comparing to processedbuffer len: ${processedBuffers.length}`);
      const samples = Array.from(int16samples);
      const minSample = Math.min(...samples);
      const maxSample = Math.max(...samples);
      const avgSample = samples.reduce((a, b) => a + b, 0) / samples.length;
      logger.debug(`[LiveKit] Buffer stats: min=${minSample}, max=${maxSample}, avg=${avgSample}`);

      try {
        if (!shared.audioSource || !shared.audioTrackPublished) {
          logger.debug("[AudioRecv] Audio source not active or unpublished, skipping frame.");
          return;
        }        
        logger.debug(`[DEBUG] shared.audioSource is:", ${shared.audioSource}`);
        logger.debug(`[DEBUG] shared.audioTrack  is:", ${shared.audioTrack}`);
        logger.debug(`[DEBUG] audioTrackPublished is:", ${shared.audioTrackPublished}`);

        const frame = new AudioFrame(int16samples, 48000, 1, int16samples.length);
        if (!audiostarted) {
          mediaEvents.emit('audio-ready', { shared });
          audiostarted = true;
        }
        await shared.audioSource.captureFrame(frame);
      } catch (err: any) {
        shared.audioTrackPublished = false; // block future calls
        logger.error("[LiveKit] captureFrame failed:", err?.message || err);
      }
      } catch (err) {
      logger.error("[AudioProcessor] Error receiving audio:", err);
      audiostarted = false

      break;
    }
  }
  audiostarted = false

  await saveProcessedAudioToFile(processedBuffers);
}

// Function to save received PCM audio to a WAV file
async function saveProcessedAudioToFile(buffers: Buffer[]) {
  if (buffers.length === 0) {
    logger.debug("[AudioProcessor] No audio data received, skipping WAV creation.");
    return;
  }

  const outputData = Buffer.concat(buffers);
  logger.info(`[AudioProcessor] Total processed data: ${outputData.length} bytes in ${buffers.length} frames.`);

  // Convert received PCM data to Int16Array suitable for WAV file
  const int16Samples = new Int16Array(outputData.buffer, outputData.byteOffset, outputData.length / 2);

  const wav = new WaveFile();
  wav.fromScratch(1, 48000, '16', int16Samples);

  const outputFilePath = path.join(process.cwd(), `processed_zmq_rcv.wav`);

  try {
    await fs.promises.writeFile(outputFilePath, wav.toBuffer());
    logger.info(`[AudioProcessor] Processed audio successfully saved to: ${outputFilePath}`);
  } catch (err) {
    logger.error("[AudioProcessor] Failed to save WAV file:", err);
  }

  // Clear buffers after saving
  processedBuffers = [];
}
