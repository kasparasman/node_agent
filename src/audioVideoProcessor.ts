// audioVideoProcessor.ts
import { mediaEvents } from './emitter.js';
import type { SharedState } from './main_agent.js'; // or from 'types.js' if separated
import { MediaStreamTrack } from '@roamhq/wrtc';
import pkg from '@roamhq/wrtc';
const { RTCAudioSink } = pkg.nonstandard;
import { logger } from './logger.js';
import fs from 'fs';
import {receiveProcessedAudio} from './audio_recv.js'
let audioSink: RTCAudioSink | null = null;
let audioFile: fs.WriteStream | null = null;
let pcmQueue: Buffer[] = [];
let sending = false;
const TARGET_BUFFER_BYTES = 19200; // 200ms at 48kHz, 16-bit mono PCM
let persistentBuffer = Buffer.alloc(0);

logger.info('Listener registered: audio-started');

mediaEvents.on('audio-started', (track: MediaStreamTrack, shared: SharedState ) => {
    logger.debug('Audio started, processing begins.');
  processAudioTrack(track, shared);
  (async () => {
    try {
        await receiveProcessedAudio(shared);
    } catch (err) {
        logger.error('[Main] Error in receiveProcessedAudio:', err);
    }
})();
});

mediaEvents.on('audio-stopped', async (track: MediaStreamTrack, shared: SharedState) => {
    logger.debug('[Processor] Audio stopped, cleaning up audio resources...');
    await cleanupAudioProcessing(shared);
  });


async function processAudioTrack(track: MediaStreamTrack, shared: SharedState) {
    audioFile = fs.createWriteStream('test.pcm', { flags: 'w' });
  
    audioSink = new RTCAudioSink(track);
  
    audioSink.ondata = ({ samples }) => {
      const pcmBuffer: Buffer = Buffer.from(samples.buffer);
      audioFile?.write(pcmBuffer);
      pcmQueue.push(pcmBuffer);
      accumulateAndSend(shared);
    };
  
    track.onended = () => {
      logger.info('Audio track ended. Cleaning up audio sink.');
      audioSink?.stop();
    };
  }
  async function accumulateAndSend(shared: SharedState) {
    while (pcmQueue.length > 0) {
      persistentBuffer = Buffer.concat([persistentBuffer, pcmQueue.shift()!]);
  
      while (persistentBuffer.length >= TARGET_BUFFER_BYTES) {
        const block = persistentBuffer.slice(0, TARGET_BUFFER_BYTES);
        persistentBuffer = persistentBuffer.slice(TARGET_BUFFER_BYTES);
  
        if (shared.in_dealer) {
          try {
            await shared.in_dealer.send(block);
            logger.debug('Sent processed audio block');
          } catch (err) {
            logger.error('Error sending block via ZMQ:', err);
          }
        }
      }
    }
  }
  
 
  
  async function cleanupAudioProcessing(shared: SharedState) {
    audioSink?.stop();
    audioSink = null;
    audioFile?.end();
    audioFile = null;
  
    if (persistentBuffer.length > 0 && shared.in_dealer) {
      await shared.in_dealer.send(persistentBuffer);
      persistentBuffer = Buffer.alloc(0);
      logger.debug('Sent remaining audio data.');
    }
  
    // Send EOF sentinel
    if (shared.in_dealer) {
      try {
        await shared.in_dealer.send(Buffer.from('EOF'));
        logger.debug('EOF sent to ZMQ');
      } catch (err) {
        logger.error('Error sending EOF:', err);
      }
    }
  
    pcmQueue.length = 0;
  }

   
async function sendQueue(shared: SharedState) {
  if (sending || pcmQueue.length === 0) return;
  sending = true;

  while (pcmQueue.length > 0) {
    const buffer = pcmQueue.shift();
    if (shared.in_dealer && shared.out_dealer &&buffer) {
     // const floatBuffer = pcm16ToFloat32(buffer); // Convert to float32
      try {
        await shared.in_dealer.send(buffer);
      } catch (err) {
        logger.error('[ZMQ] Send error:', err);
        break;  // Optionally break or handle retry logic
      }
    }
  }
  sending = false;
}

function pcm16ToFloat32(pcmBuffer: Buffer): Buffer {
  const float32Buffer = Buffer.alloc(pcmBuffer.length * 2); // 16-bit PCM to 32-bit float
  for (let i = 0, j = 0; i < pcmBuffer.length; i += 2, j += 4) {
    const intSample = pcmBuffer.readInt16LE(i);
    const floatSample = intSample / 32768; // Normalize to [-1, 1]
    float32Buffer.writeFloatLE(floatSample, j);
  }
  return float32Buffer;
}

function stereoToMono(stereoBuffer: Buffer): Buffer {
  const monoBuffer = Buffer.alloc(stereoBuffer.length / 2);
  for (let i = 0, j = 0; i < stereoBuffer.length; i += 4, j += 2) {
    const left = stereoBuffer.readInt16LE(i);
    const right = stereoBuffer.readInt16LE(i + 2);
    const monoSample = (left + right) / 2;
    monoBuffer.writeInt16LE(monoSample, j);
  }
  return monoBuffer;
}