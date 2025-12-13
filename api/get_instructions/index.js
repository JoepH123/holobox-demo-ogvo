import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

    const accountName   = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey    = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const containerName = "vectorbase-file-storage";
    const defaultBlob = "data/instruction prompt_file_instruction prompt.txt";

export default async function (context, req) {
  try {
    const blobName = defaultBlob;

    // Create credential + client
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const serviceClient = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      credential
    );
    const containerClient = serviceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    // Download the blob
    const downloadResponse = await blobClient.download();
    const text = await streamToString(downloadResponse.readableStreamBody);

    context.res = {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text
    };
  } catch (err) {
    context.log.error(err);
    context.res = {
      status: 500,
      body: `Failed to read blob: ${err.message}`
    };
  }
}

// Convert stream -> string
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(d.toString("utf8")));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}
