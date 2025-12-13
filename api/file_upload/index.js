// api/file_upload/index.js
import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  BlobSASPermissions
} from "@azure/storage-blob";

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const accountKey  = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const containerName = "file-attachment-storage";

const credential = new StorageSharedKeyCredential(accountName, accountKey);
const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);

export default async function (context, req) {
  try {
    const filename = (req.query.filename || "file").replace(/[^\w.\-]+/g, "_");
    const blobName = `${Date.now()}-${filename}`;
    const containerClient = blobServiceClient.getContainerClient(containerName);

    await containerClient.createIfNotExists();

    const expiresOn = new Date(Date.now() + 60 * 60 * 1000);
    const permissions = BlobSASPermissions.parse("cw");

    const sas = generateBlobSASQueryParameters(
      { containerName, blobName, permissions, expiresOn },
      credential
    ).toString();

    const url = `${containerClient.getBlockBlobClient(blobName).url}?${sas}`;
    context.res = { status: 200, headers: { "Content-Type": "text/plain" }, body: url };
  } catch (err) {
    context.log?.error?.(err);
    context.res = { status: 500, body: "Failed to create SAS URL" };
  }
}

