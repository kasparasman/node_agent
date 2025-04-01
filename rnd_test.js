import zmq from 'zeromq';
import fs from 'fs';
import path from 'path';

async function runClient() {
  const dealer = new zmq.Dealer();
  const endpoint = "ipc:///tmp/router_dealer_stream.ipc";
  await dealer.connect(endpoint);
  console.log("Node DEALER connected to", endpoint);
  
  // Read input.wav from the current working directory.
  const inputFilePath = path.join(process.cwd(), "azure_011.wav");
  let originalBuffer;
  try {
    originalBuffer = await new Promise((resolve, reject) => {
      fs.readFile(inputFilePath, (err, data) => {
        if (err) {
          console.error('Error reading input.wav:', err);
          reject(err);
          return;
        }
        resolve(data);
      });
    });
  } catch (error) {
    console.error("Error reading file:", error);
    return; // Exit the function if file reading fails
  }

  const outputFilePath = path.join(process.cwd(), "output.wav");
  const outStream = fs.createWriteStream(outputFilePath);
  const receiver = (async () => {
    while (true) {
      const msgParts = await dealer.receive();
      // Depending on the envelope, choose the data frame.
      let msg;
      if (msgParts.length === 1) {
        msg = msgParts[0];
      } else {
        msg = msgParts[1];
      }
      if (msg.toString() === "EOF") {
        console.log("Received EOF from Python, ending receiver loop.");
        break;
      }
      outStream.write(msg);
      process.stdout.write(`Sent chunk: ${msg.length} \r`);
    }

    outStream.end();
  })();

  console.log("Total bytes of input.wav:", originalBuffer.length);
  let chunksCount = 0;
  // Send the file data in 640-byte chunks.
  const chunkSize = 640;
  for (let offset = 0; offset < originalBuffer.length; offset += chunkSize) {
    const chunk = originalBuffer.slice(offset, offset + chunkSize);
    await dealer.send(chunk);
    process.stdout.write(`Sent chunk: ${chunk.length} bytes; chunk count: ${chunksCount}\r`);

    // Optional delay between chunks (20 ms)
    chunksCount++;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  
  // Send EOF signal to indicate the end of transmission.
  await dealer.send("EOF");
  console.log("Sent EOF, waiting for reply...");
  process.stdout.write('\n'); // moves to the next line

  console.log("chunks count:", chunksCount);
  // Wait for the reply from the Python server.
  await receiver;
  dealer.close();
  console.log("Streaming complete. Output written to", outputFilePath);

}

runClient().catch(err => {
  console.error("Error in client:", err);
});
