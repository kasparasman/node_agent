// node_agent_stream.js
import zmq from 'zeromq';
import fs from 'fs/promises';
import path from 'path';
import pkg from 'wavefile';
const { WaveFile } = pkg;

async function runNodeStreaming(wavFilePath) {
  // Create two ROUTER sockets: one for raw input and one for processed output.
  const rawRouter = new zmq.Router();
  const procRouter = new zmq.Router();

  await rawRouter.bind("ipc:///tmp/audio_input.ipc");
  await procRouter.bind("ipc:///tmp/audio_output.ipc");

  console.log("Node ROUTER for raw input bound to ipc:///tmp/audio_input.ipc");
  console.log("Node ROUTER for processed output bound to ipc:///tmp/audio_output.ipc");

  // ----- Handshake on raw input channel -----
  let [rawDealerId, rawMsg] = await rawRouter.receive();
  if (rawMsg.toString() === "READY") {
    await rawRouter.send([rawDealerId, "GO"]);
    console.log("Raw channel handshake complete");
  } else {
    console.error("Unexpected handshake on raw channel:", rawMsg.toString());
    return;
  }

  // ----- Handshake on processed output channel -----
  let [procDealerId, procMsg] = await procRouter.receive();
  if (procMsg.toString() === "READY") {
    await procRouter.send([procDealerId, "OK"]);
    console.log("Processed channel handshake complete");
  } else {
    console.error("Unexpected handshake on processed channel:", procMsg.toString());
    return;
  }

  // Read and parse the input WAV file.
  const data = await fs.readFile(wavFilePath);
  const wf = new WaveFile(data);
  wf.toBitDepth(16); // Ensure 16-bit depth

  // Hardcoded parameters.
  const sampleRate = 48000;  // Entire chain uses 16 kHz final rate.
  const bitsPerSample = 16;
  const channels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const frameDuration = 20; // ms
  const frameSize = Math.floor((sampleRate * bytesPerSample * frameDuration * channels) / 1000);

  const audioData = Buffer.from(wf.data.samples);
  let offset = 0;
  let processedBuffers = [];

  // ----- Async loop: Sending raw frames -----
  const sendRaw = (async () => {
    while (offset < audioData.length) {
      const frame = audioData.slice(offset, offset + frameSize);
      offset += frameSize;
      // Send the frame on the raw channel using the known dealer identity.
      await rawRouter.send([rawDealerId, frame]);
      console.log(`Sent raw frame of ${frame.length} bytes`);
      // Simulate real-time transmission.
      await new Promise(resolve => setTimeout(resolve, frameDuration));
    }
    // When finished, send an EOF signal.
    await rawRouter.send([rawDealerId, "EOF"]);
    console.log("Sent EOF on raw channel");
  })();
  const eofMarker = Buffer.from("EOF");

  // ----- Async loop: Receiving processed frames -----
  const receiveProcessed = (async () => {
    while (true) {
      // The ROUTER returns a multipart message [identity, payload]
      let [dealerId, msg] = await procRouter.receive();
      if (msg.equals(eofMarker)) {
        console.log("Received EOF on processed channel");
        break;
      }
      console.log(`Received processed frame of ${msg.length} bytes`);
      processedBuffers.push(msg);
    }
  })();
  

  // Wait for both loops to finish.
  await Promise.all([sendRaw, receiveProcessed]);

  // Combine the processed frames and write the output WAV file.
  const outputData = Buffer.concat(processedBuffers);
  console.log(`Total processed data length: ${outputData.length} bytes`);
  console.log("Total number of processed frames:", processedBuffers.length);


  const outputWav = new WaveFile();
  // Create a new WAV file (mono, 16 kHz, 16-bit)
  const int16Samples = new Int16Array(outputData.buffer, outputData.byteOffset, outputData.length / 2);

  outputWav.fromScratch(1, sampleRate, '16', int16Samples);
  const outputFilePath = path.join(process.cwd(), `processed_${Date.now()}.wav`);
  await fs.writeFile(outputFilePath, outputWav.toBuffer());
  console.log(`Processed WAV saved to ${outputFilePath}`);

  rawRouter.close();
  procRouter.close();
}

runNodeStreaming(path.join(process.cwd(), "test.wav")).catch(console.error);
