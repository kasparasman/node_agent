// main.ts
'use strict';

import fetch from 'node-fetch'; // v2 for CommonJS
import wrtc from '@roamhq/wrtc';
const { RTCPeerConnection, RTCSessionDescription, RTCVideoSource, MediaStream } = wrtc;

import {
  IngressClient,
  RoomServiceClient,
  IngressInput,
  IngressInput as IngressInputEnum, // alias for clarity if needed
} from 'livekit-server-sdk';

// ----- Configuration -----
// Replace these with your actual LiveKit Cloud details.
const LIVEKIT_HOST = "https://anthropos-johj940b.livekit.cloud";
const API_KEY = "API55oTdoKqA4ju";
const API_SECRET = "CORYEfMwhI4R3Gw9yj0IhN2xn8eflvCXdrRqCP2bJ0eC";
const ROOM_NAME = "RM_pDAPci5tjqrE";
async function clearExistingIngresses(ingressClient) {
    try {
      console.info("Fetching existing ingresses...");
      const ingresses = await ingressClient.listIngress();
      console.info("Existing ingresses:", ingresses);
      for (const ingress of ingresses) {
        console.info(`Deleting ingress with id: ${ingress.ingressId}`);
        await ingressClient.deleteIngress(ingress.ingressId);
        console.info(`Deleted ingress ${ingress.ingressId}`);
      }
    } catch (error) {
      console.error("Error clearing ingresses:", error);
    }
  }
  
// Ingress payload configuration – WHIP input type (1)
const ingressPayload = {
  name: "ingress_stream",
  roomName: ROOM_NAME,
  participantIdentity: "ingress_stream_participant",
  participantName: "Ingress Participant",
  enableTranscoding: false,
  bypassTranscoding: true,
  // input_type is implied by the IngressInput enum below.
};

// ICE servers for our WHIP connection; default to Google STUN.
const DEFAULT_ICESERVERS = [{ urls: ["stun:stun.l.google.com:19302"] }];

// ----- Create LiveKit Room & Ingress via Server SDK -----
async function setupLiveKitIngress() {
  // Instantiate the LiveKit RoomServiceClient and IngressClient.
  const roomClient = new RoomServiceClient(LIVEKIT_HOST, API_KEY, API_SECRET);
  const ingressClient = new IngressClient(LIVEKIT_HOST, API_KEY, API_SECRET);

  // Create a room.
  console.info("Creating room on LiveKit...");
  const room = await roomClient.createRoom({ name: ROOM_NAME });
  console.info("Room created with SID:", room.sid);
  await clearExistingIngresses(ingressClient);

  // Create an ingress session using WHIP input.
  console.info("Creating ingress session for room...");
  // Note: IngressInput.WHIP_INPUT indicates WHIP ingestion.
  const ingress = await ingressClient.createIngress(IngressInput.WHIP_INPUT, {
    ...ingressPayload,
    roomName: room.sid, // or room.name, based on your configuration
  });
  console.info("Ingress created:", ingress);
  return ingress;
}

// ----- WHIP Client using wrtc -----
// This function creates an RTCPeerConnection, attaches a dummy video track
// (to force SDP negotiation), creates an SDP offer, sends it to the ingress endpoint,
// receives the SDP answer, and sets the remote description.
async function connectToIngress(ingressUrl, streamKey) {
  console.info("Creating RTCPeerConnection for WHIP connection...");
  const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICESERVERS });

  // Optional: log ICE candidates.
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("ICE candidate:", event.candidate);
    }
  };

  // Create a dummy video track to force negotiation.
  // Force SDP negotiation for video by adding a transceiver in sendonly mode.
  pc.addTransceiver("video", { direction: "sendonly" });

  // Create SDP offer.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  console.info("Local SDP offer generated:\n", offer.sdp);

  // Build WHIP payload and POST the offer.
  const payload = {
    projectId: "anthropos-johj940b", // add your projectId here
    streamKey: streamKey,
    sdp: offer.sdp,
  };

  console.info("Posting SDP offer to ingress at:", ingressUrl);
  const response = await fetch(ingressUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Error connecting to ingress: ${response.status} - ${responseBody}`);
  }
  const json = JSON.parse(responseBody);
  console.info("Received ingress response:", json);

  // Create an SDP answer from the response.
  const answer = new RTCSessionDescription({ type: "answer", sdp: json.sdp });
  await pc.setRemoteDescription(answer);
  console.info("Set remote description from ingress SDP answer.");
  
  // Log connection state changes.
  pc.onconnectionstatechange = () => {
    console.log("WHIP connection state:", pc.connectionState);
  };

  return pc;
}

// ----- Main Flow -----
async function main() {
  try {
    // Step 1: Create room and ingress.
    const ingressInfo = await setupLiveKitIngress();
    // ingressInfo is expected to contain fields such as:
    // ingressId, streamKey, and url.
    if (!ingressInfo.url || !ingressInfo.streamKey) {
      throw new Error("Invalid ingress response: missing url or streamKey");
    }
    console.info("Ingress Info:", ingressInfo);

    // Step 2: Connect to ingress via WHIP.
    const pcIngress = await connectToIngress(ingressInfo.url, ingressInfo.streamKey);
    console.info("WHIP connection established.");

    // For testing, you can now wait and monitor the connection.
    console.info("WHIP connection is active. Press Ctrl+C to exit.");
    // Keep the process running.
    console.log("Deleting ingress...");
    await ingressClient.deleteIngress(ingressInfo.ingressId);
    console.log("Ingress deleted.");
    await new Promise(() => {});
  } catch (error) {
    console.error("Error in mediator:", error);
    process.exit(1);
  }
}

main();
