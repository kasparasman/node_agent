// pinecone.ts
import { Pinecone } from '@pinecone-database/pinecone';
import { logger } from './logger.js';
import { INDEX_NAME, NAMESPACE, MODEL_NAME } from './config.js';

export async function getRetrievedContext(queryText: string): Promise<string> {
  let vector: number[] = [];
  try {
    const pc = new Pinecone();
    const embedResponse = await pc.inference.embed(MODEL_NAME, [queryText], {
      inputType: "query",
      truncate: "END",
    });
    const denseEmbedding = embedResponse.data[0] as { values: number[] };
    vector = denseEmbedding.values;
    logger.debug("[Pinecone] Generated query vector.");
  } catch (err) {
    logger.error("[Pinecone] Error generating embedding:", err);
  }
  let retrievedContext = "RELEVANT CONTEXT:\n";
  try {
    const pc = new Pinecone();
    const index = pc.index(INDEX_NAME).namespace(NAMESPACE);
    const queryResponse = await index.query({
      topK: 4,
      vector,
      includeMetadata: true,
    });
    if (queryResponse.matches?.length) {
      queryResponse.matches.forEach((match: any) => {
        const snippet = match.metadata?.text || "No text found.";
        retrievedContext += `- ${snippet}\n`;
      });
    } else {
      retrievedContext += "- No relevant docs found.\n";
    }
    logger.debug("[Pinecone] Query completed.");
  } catch (err) {
    logger.error("[Pinecone] Error querying index:", err);
  }
  return retrievedContext;
}
