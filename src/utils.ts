// utils.ts
import { logger } from './logger.js';

export function updateConsoleBitrateLine(currentVideoBitrate: number, currentAudioBitrate: number, statusMessage: string) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(
    `[BITRATE] Video: ${currentVideoBitrate.toFixed(2)} bps | Audio: ${currentAudioBitrate.toFixed(2)} bps ${statusMessage}`
  );
}

export async function waitForVideoOrStreamReady(
  videoIsPlaying: boolean,
  isStreamReady: boolean,
  timeout = 5000
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (videoIsPlaying || isStreamReady) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

export async function waitForTrackBitrate(
  kind: 'video' | 'audio',
  currentVideoBitrate: number,
  currentAudioBitrate: number,
  threshold: number,
  timeout = 5000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (kind === 'video' && currentVideoBitrate >= threshold) return true;
    if (kind === 'audio' && currentAudioBitrate >= threshold) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

import { getRetrievedContext as pineconeGetRetrievedContext } from './pinecone.js';
export async function pineconePingLoop() {
  while (true) {
    try {
      const pingQuery = "zinzino";
      const context = await pineconeGetRetrievedContext(pingQuery);
      logger.info("[Pinecone Ping] Successfully retrieved context.");
    } catch (error) {
      logger.error("[Pinecone Ping] Error during ping:", error);
    }
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}
