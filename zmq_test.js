import zmq from 'zeromq';
import crypto from 'crypto';
import { promisify } from 'util';

// Define IPC endpoint for testing
const DATA_ENDPOINT = "ipc:///tmp/dummy_data.ipc";
const HASH_ENDPOINT = "ipc:///tmp/dummy_hash.ipc";
const HANDSHAKE_ENDPOINT = "ipc:///tmp/handshake.ipc";

let dataPub;
let hashSub;
let handshakeReq;
let handshakeRep;
async function initHandshakeReq() {
  handshakeReq = new zmq.Request();
  await handshakeReq.connect(HANDSHAKE_ENDPOINT);
  console.log("Handshake REQ connected to", HANDSHAKE_ENDPOINT);
}
async function initHandshakeRep() {
  handshakeRep = new zmq.Reply();
  await handshakeRep.bind(HANDSHAKE_ENDPOINT);
  console.log("Handshake Rep connected to", HANDSHAKE_ENDPOINT);
}
async function initpub() {
  dataPub = new zmq.Publisher();
  await dataPub.bind(DATA_ENDPOINT);
  console.log("Dummy publisher bound to", DATA_ENDPOINT);
}

async function initsub() {
  hashSub = new zmq.Subscriber();
  await hashSub.connect(HASH_ENDPOINT);
  hashSub.subscribe("");
  console.log("Dummy subscriber connected to", HASH_ENDPOINT);
}


// Dummy Publisher: sends a known pattern divided into chunks.
async function dummyPublisher() {
  // Create a dummy buffer with a known pattern (e.g., 10 KB)
  const originalBuffer = Buffer.alloc(10240);
  for (let i = 0; i < originalBuffer.length; i++) {
    originalBuffer[i] = i % 256;
  }
  
  console.log("Total bytes before chunking:", originalBuffer.length);
  
  // Calculate expected MD5 hash for comparison
  const expectedHash = crypto.createHash('md5').update(originalBuffer).digest('hex');
  console.log("Expected MD5 hash:", expectedHash);
  await initHandshakeReq();
  await handshakeReq.send("READY?");
  const handshakeReply = await handshakeReq.receive();
  if (handshakeReply.toString() !== "READY") {
    console.error("Handshake failed. Expected READY, got:", handshakeReply.toString());
    process.exit(1);
  }
  console.log("Handshake successful. Starting to send dummy data.");
  // Add a delay before starting transmission
  await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
  // Divide the buffer into chunks (simulate frames)
  const chunkSize = 640; // same as used in your production code
  for (let offset = 0; offset < originalBuffer.length; offset += chunkSize) {
    const chunk = originalBuffer.slice(offset, offset + chunkSize);
    await dataPub.send(chunk);
    console.log(`Sent chunk of ${chunk.length} bytes`);
    // Simulate a real-time delay (20 ms)
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  // Send an EOF control message to signal end of transmission
  await dataPub.send("EOF");
  console.log("Dummy publisher sent EOF and is closing.");
  await handshakeReq.send("ACK?");
  const ackReply = await handshakeReq.receive();
  if (ackReply.toString() !== "ACK") {
    console.error("Final handshake ACK failed. Expected ACK, got:", ackReply.toString());
  } else {
    console.log("Final handshake ACK received.");
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  dataPub.close();
  handshakeReq.close();
  return expectedHash; // Return for later comparison
}

// Dummy Subscriber: collects the chunks and reassembles them.
async function dummySubscriber() {
  await initHandshakeRep();
  let chunks = [];
  const subready = await handshakeRep.receive();
  if (subready == "READY?") {
    await handshakeRep.send("READY");
  }else{
    console.error("Final handshake ready failed. Expected READY?, got:", subready);
    }

  for await (const [msg] of hashSub) {
    // Check if message is the EOF control signal
    if (msg.toString() === "EOF") {
      break;
    }
    chunks.push(msg);
  }
  const ack = await handshakeRep.receive();
  if (ack == "ACK?") {
    await handshakeRep.send("ACK");
  } else {
    console.error("Final handshake ACK failed. Expected ACK, got:", ack);
  }

  // Reassemble all chunks
  const finalBuffer = Buffer.concat(chunks);
  const receivedHash = finalBuffer.toString('ascii');
  console.log("Received hash string:", receivedHash);
  return receivedHash;
}

// Main test runner that launches the publisher and subscriber.
async function runDummyTest() {
  await initpub();
  await initsub();
  // Start the dummy publisher and get the expected hash.
  const expectedHash = await dummyPublisher();
  // Give a short delay to ensure the publisher is ready.
  await new Promise(resolve => setTimeout(resolve, 500));
  // Run the dummy subscriber.
  const receivedHash = await dummySubscriber();

  if (expectedHash === receivedHash) {
    console.log("SUCCESS: The reassembled buffer matches the original.");
  } else {
    console.log("FAILURE: The reassembled buffer does not match the original.");
    console.log(`Expected: ${expectedHash}`);
    console.log(`Received: ${receivedHash}`);
  
  }
  dataPub.close();  // Close the publisher
  hashSub.close();  // Close the subscriber

}
runDummyTest().catch(err => {
  console.error("Error in dummy test:", err);
});
