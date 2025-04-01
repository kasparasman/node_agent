// videoProcessor.ts
import { logger } from './logger.js';
import { mediaEvents } from './emitter.js';
import pkg from '@roamhq/wrtc';
const { RTCVideoSink } = pkg.nonstandard;
import { TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
// Save track when received
let incomingTrack = null;
mediaEvents.on('video-started', (track, shared) => {
    logger.info(`[Debug] Track state before publishing: 
    id=${track.id}, 
    kind=${track.kind}, 
    readyState=${track.readyState}, 
    muted=${track.muted}, 
    enabled=${track.enabled}`);
    incomingTrack = track;
    const publishOptions = new TrackPublishOptions();
    setTimeout(async () => {
        await shared.room.localParticipant.publishTrack(incomingTrack, {
            name: 'avatar-video',
            source: TrackSource.SOURCE_CAMERA,
        });
    }, 3000);
});
