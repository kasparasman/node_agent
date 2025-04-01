// utils.ts
import { logger } from './logger.js';
export function updateConsoleBitrateLine(currentVideoBitrate, currentAudioBitrate, statusMessage) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`[BITRATE] Video: ${currentVideoBitrate.toFixed(2)} bps | Audio: ${currentAudioBitrate.toFixed(2)} bps ${statusMessage}`);
}
export async function waitForVideoOrStreamReady(videoIsPlaying, isStreamReady, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        if (videoIsPlaying || isStreamReady)
            return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}
export async function waitForTrackBitrate(kind, currentVideoBitrate, currentAudioBitrate, threshold, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (kind === 'video' && currentVideoBitrate >= threshold)
            return true;
        if (kind === 'audio' && currentAudioBitrate >= threshold)
            return true;
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
        }
        catch (error) {
            logger.error("[Pinecone Ping] Error during ping:", error);
        }
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}
