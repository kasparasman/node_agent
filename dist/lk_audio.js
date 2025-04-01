// livekitAudio.js
import { TrackPublishOptions, TrackSource, AudioFrame, AudioSource, LocalAudioTrack, } from '@livekit/rtc-node';
import { logger } from './logger.js';
export async function setupLiveKitAudioTrack(shared, sampleRate = 48000, channels = 1) {
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
export function captureLiveKitAudio(shared, samples, sessionId, sampleRate = 48000, channels = 1) {
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
    }
    catch (err) {
        logger.error('[LiveKit] Failed to capture audio frame:', err);
    }
}
