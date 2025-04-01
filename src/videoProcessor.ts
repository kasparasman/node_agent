// videoProcessor.ts
import { logger } from './logger.js';
import { publishLiveKitVideo } from './lk_video.js';
import { mediaEvents } from './emitter.js';
import type { SharedState } from './main_agent.js';
import pkg from '@roamhq/wrtc';
const { RTCVideoSink } = pkg.nonstandard;
import { VideoFrame, VideoBufferType} from '@livekit/rtc-node';

// In‑memory buffer to accumulate video frames
type BufferedVideoFrame = {
  width: number;
  height: number;
  buffer: Uint8Array;
  format?: VideoBufferType;
};
let videoFrameBuffer: BufferedVideoFrame[] = [];
let lastCopiedData: Uint8Array | null = null;
const frameTimestamps: number[] = [];
const FRAME_WINDOW = 10; // number of frames over which to average

// We'll need VideoFrame from LiveKit
mediaEvents.on('video-started', (track: MediaStreamTrack, shared: SharedState ) => {
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
export async function processVideoTrack(track: MediaStreamTrack, shared: SharedState): Promise<RTCVideoSink> {
  logger.info(`[VideoProcessor] Received video track: ${track.id}`);
  const videoSink = new RTCVideoSink(track);
  let videoReadyEmitted = false;
  videoSink.onframe = async ({ frame: rtcFrame }) => {
    const now = Date.now();
    frameTimestamps.push(now);
    if (frameTimestamps.length > FRAME_WINDOW) {
      frameTimestamps.shift();
    }
    if (frameTimestamps.length >= 2) {
      const delta = now - frameTimestamps[0];
      const avgFps = (frameTimestamps.length - 1) / (delta / 1000);
      logger.debug(`[FPS] Average over ${frameTimestamps.length} frames: ${avgFps.toFixed(2)} fps`);
    }

    logger.debug(`[VideoProcessor] Received video frame: ${rtcFrame.width}x${rtcFrame.height}, rotation: ${rtcFrame.rotation}`);
    const expectedRGBA = rtcFrame.width * rtcFrame.height * 4;
    const expectedI420 = rtcFrame.width * rtcFrame.height * 1.5;

    logger.debug(`[Debug] Frame buffer length = ${rtcFrame.data.length}, expected RGBA = ${expectedRGBA}`);
    const source = new Uint8Array(rtcFrame.data.buffer);
    const w = rtcFrame.width;
    const h = rtcFrame.height;
    const expectedSize = w * h * 1.5;
    
    const copiedData = new Uint8Array(source.length);
    if (copiedData.length !== expectedSize) {
      logger.error(`[VideoProcessor] ❌ Invalid frame size: got ${copiedData.length}, expected ${expectedSize}`);
      return; // discard frame
    }
    
    copiedData.set(source); // ✅ TRUE deep copy
    /*shared.latestFrame = {
      buffer: copiedData,
      width: rtcFrame.width,
      height: rtcFrame.height,
      format: VideoBufferType.I420,

    };
    */
    shared.videoFrameBuffer.push({
      width: rtcFrame.width,
      height: rtcFrame.height,
      buffer: copiedData,
      format: VideoBufferType.I420,
    });
    logger.debug(`[VideoProcessor] Buffered raw video frame. Buffer size: ${shared.videoFrameBuffer.length}`);
    const yLen = rtcFrame.width * rtcFrame.height;
    const uvLen = (rtcFrame.width / 2) * (rtcFrame.height / 2);
    
    const yPlane = copiedData.slice(0, yLen);
    const uPlane = copiedData.slice(yLen, yLen + uvLen);
    const vPlane = copiedData.slice(yLen + uvLen);
    
    logger.debug(`Y Sample: ${Array.from(yPlane.slice(0, 5))}`);
    logger.debug(`U Sample: ${Array.from(uPlane.slice(0, 5))}`);
    logger.debug(`V Sample: ${Array.from(vPlane.slice(0, 5))}`);
    logger.debug(`Frame: ${rtcFrame.width}x${rtcFrame.height}, buffer=${copiedData.length}, expected=${yLen + uvLen * 2}`);
  /*  
    if (!videoReadyEmitted) {
        videoReadyEmitted = true;
        mediaEvents.emit('video-ready', { timestamp: Date.now(), shared });
        logger.info("[VideoProcessor] Emitted video-ready event.");
        
        // Only call publishLiveKitVideo on the first frame.
        if (!shared.videoTrackPublished) {
          try {
            await publishLiveKitVideo(
              shared,
              rtcFrame.width,
              rtcFrame.height
            );
            // Save the video source and track to shared state.
            logger.info("[VideoProcessor] Video track published.");
          } catch (err) {
            logger.error("[VideoProcessor] Failed to publish video track:", err);
          }
        }
      }
  
  */

    logger.debug(`[VideoProcessor] Buffered frame. Buffer length: ${videoFrameBuffer.length}`);
  };

  track.onended = () => {
    logger.info("[VideoProcessor] Video track ended. Stopping video sink.");
    videoSink.stop();
    videoFrameBuffer = [];

  };

  return videoSink;
}

/**
 * Flush the video frame buffer to the LiveKit VideoSource.
 * This should be called once the audio is ready so that both streams are published together.
 *
 * @param shared - Shared state containing the LiveKit VideoSource.
 */
export async function flushVideoBuffer(shared: SharedState): Promise<void> {
  if (!shared.videoSource) {
    logger.error("[VideoProcessor] No LiveKit video source available to flush buffer.");
    return;
  }
  logger.info(`[VideoProcessor] Flushing ${videoFrameBuffer.length} buffered video frames...`);
  
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  
  for (const bufferedFrame of videoFrameBuffer) {
    try {
      // Construct a fresh VideoFrame from the stored raw data.
      const livekitFrame = new VideoFrame(
        bufferedFrame.buffer,
        bufferedFrame.width,
        bufferedFrame.height,
        VideoBufferType.I420
      );
      const buffer = bufferedFrame.buffer;
      const w = bufferedFrame.width;
      const h = bufferedFrame.height;
      const yLen = w * h;
      const uvLen = (w / 2) * (h / 2);
      const yPlane = buffer.slice(0, yLen);
      const uPlane = buffer.slice(yLen, yLen + uvLen);
      const vPlane = buffer.slice(yLen + uvLen);
      
      console.log('Y Sample:', Array.from(yPlane.slice(0, 10)));
      console.log('U Sample:', Array.from(uPlane.slice(0, 10)));
      console.log('V Sample:', Array.from(vPlane.slice(0, 10)));
      logger.debug(`[Flush] Frame size: ${bufferedFrame.buffer.length}, width: ${bufferedFrame.width}, height: ${bufferedFrame.height}`);
      if (buffer.length !== yLen + 2 * uvLen) {
        logger.debug(`[Flush] Skipping frame with invalid buffer length: got ${buffer.length}, expected ${yLen + 2 * uvLen}`);
        continue;
      }
      
      await shared.videoSource.captureFrame(livekitFrame);
      await delay(50); // ~30 FPS pacing

    } catch (err: any) {
      logger.error("[VideoProcessor] captureFrame failed:", err?.message || err);
    }
  }
  // Clear the buffer after flushing.
  videoFrameBuffer = [];
}

// Listen for an event that indicates the audio is ready,
// and then flush the video buffer.
mediaEvents.on('audio-ready', async (eventData) => {
    logger.info("[VideoProcessor] Received audio-ready event. Setting dummy flag...");
    eventData.shared.useDummyVideo = false; // This stops sending dummy frames.
  });
  