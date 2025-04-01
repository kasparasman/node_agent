// monitor.ts
import { logger } from "./logger.js";
import { updateConsoleBitrateLine } from "./utils.js";
import { mediaEvents } from './emitter.js';
let lastVideoBytesReceived = 0;
let lastVideoStatsTimestamp = Date.now();
export let currentVideoBitrate = 0;
let videoIsPlaying = false;
let lastAudioBytesReceived = 0;
let lastAudioStatsTimestamp = Date.now();
export let currentAudioBitrate = 0;
let audioIsPlaying = false;
export function monitorVideoTrack(event, peerConnection, statusMessage, shared) {
    lastVideoStatsTimestamp = Date.now();
    setInterval(async () => {
        try {
            const now = Date.now();
            const elapsedSeconds = (now - lastVideoStatsTimestamp) / 1000;
            lastVideoStatsTimestamp = now;
            const stats = await peerConnection.getStats(event.track);
            stats.forEach((report) => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    const reportData = report.toJSON ? report.toJSON() : report;
                    const bytesDelta = reportData.bytesReceived - lastVideoBytesReceived;
                    currentVideoBitrate = (bytesDelta * 8) / elapsedSeconds;
                    logger.debug(`Video bytes received: ${reportData.bytesReceived}`);
                    logger.debug(`Current video bitrate: ${currentVideoBitrate} bps`);
                    if (reportData.bytesReceived > lastVideoBytesReceived) {
                        if (!videoIsPlaying) {
                            videoIsPlaying = true;
                            mediaEvents.emit('video-started', event.track, shared);
                            logger.info("[Monitor] Video started playing.");
                        }
                    }
                    else {
                        if (videoIsPlaying) {
                            videoIsPlaying = false;
                            mediaEvents.emit('video-stopped', event.track, shared);
                            logger.info("[Monitor] Video stopped playing.");
                        }
                    }
                    lastVideoBytesReceived = reportData.bytesReceived;
                    updateConsoleBitrateLine(currentVideoBitrate, 0, statusMessage);
                }
            });
        }
        catch (e) {
            logger.error("[Monitor] Error getting video stats:", e);
        }
    }, 500);
}
export function monitorAudioTrack(event, peerConnection, statusMessage, shared) {
    lastAudioStatsTimestamp = Date.now();
    setInterval(async () => {
        try {
            const now = Date.now();
            const elapsedSeconds = (now - lastAudioStatsTimestamp) / 1000;
            lastAudioStatsTimestamp = now;
            const stats = await peerConnection.getStats(event.track);
            stats.forEach((report) => {
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    const reportData = report.toJSON ? report.toJSON() : report;
                    const bytesDelta = reportData.bytesReceived - lastAudioBytesReceived;
                    currentAudioBitrate = (bytesDelta * 8) / elapsedSeconds;
                    logger.debug(`Audio bytes received: ${reportData.bytesReceived}`);
                    logger.debug(`Current audio bitrate: ${currentAudioBitrate} bps`);
                    if (reportData.bytesReceived > lastAudioBytesReceived) {
                        if (!audioIsPlaying) {
                            audioIsPlaying = true;
                            mediaEvents.emit('audio-started', event.track, shared);
                            logger.info("[Monitor] audio started playing.");
                        }
                    }
                    else {
                        if (audioIsPlaying) {
                            audioIsPlaying = false;
                            mediaEvents.emit('audio-stopped', event.track, shared);
                            logger.info("[Monitor] audio stopped playing.");
                        }
                    }
                    lastAudioBytesReceived = reportData.bytesReceived;
                    updateConsoleBitrateLine(currentAudioBitrate, 0, statusMessage);
                }
            });
        }
        catch (e) {
            logger.error("[Monitor] Error getting audio stats:", e);
        }
    }, 500);
}
