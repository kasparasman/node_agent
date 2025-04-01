import {
  VideoSource,
  LocalVideoTrack,
  TrackPublishOptions,
  VideoCodec,
  TrackSource,
  VideoFrame,
  VideoBufferType,
} from '@livekit/rtc-node';
import { logger } from './logger.js';
import type { SharedState, BufferedVideoFrame  } from './main_agent.js';

const WIDTH = 512;
const HEIGHT = 512;
const FPS = 25;
const FRAME_INTERVAL = 1000 / FPS; // ~33ms

// Create a dummy frame with a dark blue color.
// In ARGB terms, dark blue might be [255, 0, 0, 139] where:
//  - 255 is the alpha (fully opaque),
//  - 0 is red,
//  - 0 is green,
//  - 139 is blue.
const DARK_BLUE_COLOR = [0, 0, 139, 255];
const dummyFrameData = new Uint8Array(WIDTH * HEIGHT * 4);
for (let i = 0; i < WIDTH * HEIGHT; i++) {
  dummyFrameData.set(DARK_BLUE_COLOR, i * 4);
}

// Create a VideoFrame from the dummy frame data.
// We use RGBA here since that's how the dummy data is formatted.
const dummyFrame = new VideoFrame(dummyFrameData, WIDTH, HEIGHT, VideoBufferType.RGBA);

/**
 * Starts the video relay.
 * 
 * This function sets up LiveKit video publishing by:
 *  1. Creating a VideoSource with a fixed resolution.
 *  2. Creating a LocalVideoTrack from that source and publishing it with VP8.
 *  3. Starting a continuous loop that sends frames to the VideoSource.
 * 
 * Initially, the loop sends the dark blue dummy frame at 30 FPS.
 * Once your RTC processing sets shared.useDummyVideo to false and updates shared.latestFrame,
 * the loop will send real video frames instead.
 * 
 * @param shared - Shared state, which must include:
 *    - room: a LiveKit Room instance,
 *    - a flag useDummyVideo (initially true),
 *    - latestFrame: an object { buffer: Uint8Array, width: number, height: number } updated by your RTCVideoSink.
 */
export async function startVideoRelay(shared: SharedState): Promise<void> {
  // Create a new VideoSource with the given resolution.
  const source = new VideoSource(WIDTH, HEIGHT);
  
  // Create a local video track from the source.
  const track = LocalVideoTrack.createVideoTrack('avatar-relay', source);
  
  // Define publishing options; here we use VP8 as the codec.
  const options = new TrackPublishOptions({
    source: TrackSource.SOURCE_CAMERA,
    videoEncoding: { maxFramerate: FPS, maxBitrate: 500_000n },
    videoCodec: VideoCodec.VP8,
  });
  
  try {
    // Publish the track to LiveKit.
    await shared.room.localParticipant.publishTrack(track, options);
    logger.info("[VideoRelay] Video track published successfully.");
    shared.videoTrackPublished = true;
    // Save the VideoSource for later reference.
    shared.videoSource = source;
  } catch (err) {
    logger.error("[VideoRelay] Failed to publish video track:", err);
    return;
  }
  
  // Initially, we send dummy frames.
  shared.useDummyVideo = true;
  
  // Start a continuous loop that sends frames to LiveKit at 30 fps.
  setInterval(() => {
    if (shared.useDummyVideo) {
      // While still in dummy mode, send the dummy frame.
      source.captureFrame(dummyFrame);
      logger.debug('[VideoRelay] Sending dummy frame.');
    } else {
      // Once audio is ready and we switch to real video...
      if (shared.videoFrameBuffer && shared.videoFrameBuffer.length > 0) {
        // Flush one early captured frame per heartbeat to preserve order.
        const bufferedFrame: BufferedVideoFrame | undefined = shared.videoFrameBuffer.shift();
        if (bufferedFrame) {
          const realFrame = new VideoFrame(
            bufferedFrame.buffer,
            bufferedFrame.width,
            bufferedFrame.height,
            VideoBufferType.I420
          );
          source.captureFrame(realFrame);
          logger.debug('[VideoRelay] Flushed one buffered real frame.');
        }
      } else if (shared.latestFrame) {
        // If no buffered frame, send the latest real frame.
        const realFrame = new VideoFrame(
          shared.latestFrame.buffer,
          shared.latestFrame.width,
          shared.latestFrame.height,
          VideoBufferType.I420
        );
        source.captureFrame(realFrame);
        logger.debug('[VideoRelay] Sending latest real frame.');
      } else {
        // Fallback: if somehow no real frame is available, continue sending dummy.
        source.captureFrame(dummyFrame);
        logger.debug('[VideoRelay] No real frame available; continuing dummy.');
      }
    }
  }, FRAME_INTERVAL);
  
  logger.info('[VideoRelay] Video relay module started and streaming continuously.');
}
