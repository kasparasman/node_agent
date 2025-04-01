// lk_video.ts
import { logger } from './logger.js';
import type { SharedState } from './main_agent.js';
import { mediaEvents } from './emitter.js';
import {
  VideoSource,
  LocalVideoTrack,
  TrackSource,
  TrackPublishOptions,
  VideoCodec,
  Track
} from '@livekit/rtc-node';
const WIDTH = 512;
const HEIGHT = 512;

/**
 * Creates a LiveKit VideoSource and publishes a video track.
 *
 * @param shared - Shared state containing the LiveKit room.
 * @param width - Width of the video stream.
 * @param height - Height of the video stream.
 * @returns An object containing the VideoSource and LocalVideoTrack.
 */
export async function publishLiveKitVideo(shared: SharedState, width: number, height: number) {
  if (!shared.room) {
    throw new Error("LiveKit room not available in shared state.");
  }

  logger.info("[LiveKitVideo] Creating VideoSource...");
  const videoSource = new VideoSource(WIDTH, HEIGHT);
  const localVideoTrack = LocalVideoTrack.createVideoTrack("did-video", videoSource);

  const options = new TrackPublishOptions({
    source: TrackSource.SOURCE_CAMERA,
    videoEncoding: { maxFramerate: 30, maxBitrate: 500_000n },
    videoCodec: VideoCodec.VP8,
  });
  

  logger.info("[LiveKitVideo] Publishing video track to LiveKit room...");
  const publication = await shared.room.localParticipant.publishTrack(localVideoTrack, options);
  shared.videoTrackPublished = true;
  logger.info(`[LiveKitVideo] Video track published with SID: ${publication.sid}`);

  // Save videoSource and videoTrack in shared state for later use.
  shared.videoSource = videoSource;
  shared.videoTrack = localVideoTrack;

  return { videoSource, videoTrack: localVideoTrack };
}
