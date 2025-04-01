// livekitAudio.js
import {
    VideoFrame,
    VideoBufferType,
    TrackPublishOptions,
    LocalVideoTrack,
    VideoSource,
    TrackSource,
    AudioFrame,
    AudioSource,
    LocalAudioTrack,
} from '@livekit/rtc-node';
import { logger } from './logger.js';
import { mediaEvents } from './emitter.js';
import type { SharedState } from './main_agent.js';
export type LiveKitAudio = {
    captureAudio(samples: Int16Array): void;
  };
  
  
  export async function setupLiveKitAudioTrack(shared: SharedState, sampleRate = 48000, channels = 1) {
    if (shared.audioTrackPublished) {
      logger.debug("[LiveKit] Audio track already published. Skipping re-setup.");
      return;
    }

    if (shared.audioTrack) {
      await shared.room?.localParticipant?.unpublishTrack(shared.audioTrack);
      logger.info('[LiveKit] Unpublished old audio track.');
    }  
    
    const audioSource = new AudioSource(sampleRate, channels);
  const localAudioTrack = LocalAudioTrack.createAudioTrack('processed-audio', audioSource);

  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  const publication = await shared.room?.localParticipant?.publishTrack(localAudioTrack, publishOptions);
  shared.audioTrackPublished = true;

  logger.debug(`[LiveKit] Published new audio track: SID=${publication?.sid}`);
  
  return { audioSource, audioTrack: localAudioTrack };
  }

  export function captureLiveKitAudio(shared: SharedState, samples: Int16Array, sessionId: string, sampleRate = 48000, channels = 1) {
    if (shared.audioSessionId !== sessionId) {
      logger.debug(`[LiveKit] Ignoring stale audio frame for session: ${sessionId}`);
      return;
    }
    if (!shared.audioSource) {
      logger.error('[LiveKit] AudioSource is not initialized. Cannot capture frame.');
      return;
    }
  
    const frame = new AudioFrame(samples, sampleRate, channels, samples.length / channels);
    try {
      shared.audioSource.captureFrame(frame);
      logger.debug('[LiveKit] Captured audio frame.');
    } catch (err) {
      logger.error('[LiveKit] Failed to capture audio frame:', err);
    }
  }
    