// videoProcessor.ts
import { logger } from './logger.js';
import { publishLiveKitVideo } from './lk_video.js';
import { mediaEvents } from './emitter.js';
import pkg from '@roamhq/wrtc';
const { RTCVideoSink } = pkg.nonstandard;
import { VideoFrame, VideoBufferType } from '@livekit/rtc-node';
mediaEvents.on('video-started', (track, shared) => {
    logger.debug('video started, processing begins.');
    processVideoTrack(track, shared).catch(err => {
        logger.error("Error processing video track:", err);
    });
});
/**
 * Processes a video track by attaching a video sink.
 * It buffers incoming video frames, and once the audio module signals that
 * the audio is ready (via an event), the buffered frames are flushed to LiveKit.
 *
 * @param track - The incoming video track (from D-ID, etc.)
 * @param shared - Shared state object
 * @returns The RTCVideoSink instance for management
 */
export async function processVideoTrack(track, shared) {
    logger.info(`[VideoProcessor] Received video track: ${track.id}`);
    const videoSink = new RTCVideoSink(track);
    let videoReadyEmitted = false;
    videoSink.onframe = async ({ frame: rtcFrame }) => {
        const frameData = new Uint8Array(rtcFrame.data.buffer);
        if (!videoReadyEmitted) {
            videoReadyEmitted = true;
            mediaEvents.emit('video-ready', { timestamp: Date.now(), shared });
            logger.info("[VideoProcessor] Emitted video-ready event.");
            // Only call publishLiveKitVideo on the first frame.
            if (!shared.videoTrackPublished) {
                try {
                    await publishLiveKitVideo(shared, rtcFrame.width, rtcFrame.height);
                    // Save the video source and track to shared state.
                    logger.info("[VideoProcessor] Video track published.");
                }
                catch (err) {
                    logger.error("[VideoProcessor] Failed to publish video track:", err);
                }
            }
        }
        const livekitFrame = new VideoFrame(frameData, rtcFrame.width, rtcFrame.height, VideoBufferType.I420);
        shared.videoSource.captureFrame(livekitFrame);
    };
    track.onended = () => {
        logger.info("[VideoProcessor] Video track ended. Stopping video sink.");
        videoSink.stop();
    };
    return videoSink;
}
