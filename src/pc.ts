// peerConnection.ts
import pkg from '@roamhq/wrtc';
const { RTCPeerConnection, RTCDataChannel, RTCTrackEvent } = pkg;
import sdpTransform from 'sdp-transform';
import { logger } from "./logger.js";
import { sendDIDMessage } from "./did_ws.js";
import { PRESENTER_TYPE } from "./config.js";
import type { SharedState } from './main_agent.js'; // or from 'types.js' if separated
import { monitorAudioTrack, monitorVideoTrack } from './monitor.js';
export function onStreamEvent(messageEvent: MessageEvent, pcDataChannel: RTCDataChannel | null): void {
  if (pcDataChannel && pcDataChannel.readyState === 'open') {
    const [event, _] = messageEvent.data.split(':');
    let status = '';
    switch (event) {
      case 'stream/started':
        status = 'started';
        break;
      case 'stream/done':
        status = 'done';
        break;
      case 'stream/ready':
        status = 'ready';
        break;
      case 'stream/error':
        status = 'error';
        break;
      default:
        status = 'dont-care';
        break;
    }
    if (status === 'ready') {
      setTimeout(() => {
        logger.info('stream/ready received from data channel');
        // You might set an external flag or call a callback here.
      }, 1000);
    } else {
      logger.info(`Received data channel event: ${status}`);
    }
  }
}

export async function createPeerConnection(
    shared: SharedState,
    offer: RTCSessionDescriptionInit,
    iceServers: RTCIceServer[]
  ): Promise<RTCPeerConnection> {
    const peerConnection = new RTCPeerConnection({ iceServers });
  const pcDataChannel = peerConnection.createDataChannel('JanusDataChannel');
  pcDataChannel.onmessage = (event) => {
    onStreamEvent(event, pcDataChannel);
    try {
      const messageData = typeof event.data === "string"
        ? JSON.parse(event.data)
        : JSON.parse(new TextDecoder().decode(new Uint8Array(event.data)));
      logger.info("[D-ID] Received data channel JSON message.");
    } catch (err) {
      logger.info(`[D-ID] Received data channel text message: ${event.data}`);
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (shared.ws) {
        if (event.candidate) {
        const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
        sendDIDMessage(shared.ws, {
          type: 'ice',
          payload: { session_id: shared.sessionId, candidate, sdpMid, sdpMLineIndex },
        });
      } else {
        sendDIDMessage(shared.ws, {
          type: 'ice',
          payload: { session_id: shared.sessionId, candidate: null, stream_id: shared.streamId, presenter_type: PRESENTER_TYPE },
        });
      }
    }
  };
  peerConnection.ontrack = (event) => {
    logger.debug(`[WebRTC] Track received: ${event.track.kind}`);

    if (event.track.kind === 'audio') {
      monitorAudioTrack(event, peerConnection, "[Audio Monitoring]", shared);
    } else if (event.track.kind === 'video') {
      monitorVideoTrack(event, peerConnection, "[Video Monitoring]", shared);
      //if the tracks pass the monitor and return a active emitter, then we 
      //pass them to sender to router
    }
  };
    
  logger.debug("[D-ID] Remote SDP offer received.");
  await peerConnection.setRemoteDescription(offer);
  logger.debug("[D-ID] Remote SDP set.");
  const sessionClientAnswer = await peerConnection.createAnswer();
  logger.debug("[D-ID] Local SDP answer created.");
  if (!sessionClientAnswer.sdp) throw new Error("SDP is undefined");
  const sdpObj = sdpTransform.parse(sessionClientAnswer.sdp);
  const videoMedia = sdpObj.media.find((m) => m.type === "video");
  if (videoMedia && (!videoMedia.payloads || videoMedia.payloads.toString().trim() === "0")) {
    logger.info("[D-ID] Video m-section empty. Applying fallback.");
    videoMedia.payloads = "100 101";
    videoMedia.direction = "recvonly";
    if (!videoMedia.rtp || videoMedia.rtp.length === 0) {
      videoMedia.rtp = [
        { payload: 100, codec: "VP8", rate: 90000 },
        { payload: 101, codec: "rtx", rate: 90000 },
      ];
    }
    if (!videoMedia.fmtp || videoMedia.fmtp.length === 0) {
      videoMedia.fmtp = [{ payload: 101, config: "apt=100" }];
    }
    if (!videoMedia.rtcpFb || videoMedia.rtcpFb.length === 0) {
      videoMedia.rtcpFb = [
        { payload: 100, type: "nack" },
        { payload: 100, type: "nack", subtype: "pli" },
        { payload: 100, type: "goog-remb" },
      ];
    }
    sessionClientAnswer.sdp = sdpTransform.write(sdpObj);
    logger.debug("[D-ID] Modified SDP answer.");
  } else {
    logger.debug("[D-ID] Video m-section valid.");
  }
  logger.debug("[D-ID] Setting local SDP answer...");
  await peerConnection.setLocalDescription(sessionClientAnswer);
  shared.peerConnection = peerConnection;

  logger.debug("[D-ID] Local SDP set successfully.");
  return peerConnection;
}
