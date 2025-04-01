import { logger } from './logger.js';
import { mediaEvents } from './emitter.js';
let isAudioReady = false;
let isVideoReady = false;
mediaEvents.on('audio-ready', () => {
    isAudioReady = true;
});
mediaEvents.on('video-ready', () => {
    isVideoReady = true;
});
function checkAndPublish() {
    if (isAudioReady && isVideoReady) {
        logger.info("Both audio and video are ready. Publishing A/V tracks together.");
    }
}
