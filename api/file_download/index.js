// api/file_download/index.js
import {
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";

const accountName   = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const accountKey    = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const containerName = "vectorbase-file-storage";

const cred = new StorageSharedKeyCredential(accountName, accountKey);

export default async function (context, req) {
  try {
    const raw = context.bindingData?.fn ?? req.query?.fn;
    if (!raw) {
      context.res = { status: 400, body: "Missing 'fn' (blob name) in route or query" };
      return;
    }

    // Decode route/query and ensure it lives under the `data/` prefix exactly once.
    const fnDecoded = decodeURIComponent(raw);
    const blobName  = fnDecoded.startsWith("data/") ? fnDecoded : `data/${fnDecoded}`;

    const downloadName = (req.query?.downloadName || blobName.split("/").pop() || "download").replace(/"/g, "'");

    const expiresOn   = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    const permissions = BlobSASPermissions.parse("r");

    const sas = generateBlobSASQueryParameters(
      {
        containerName,
        blobName, // <-- use the normalized name for the signature
        permissions,
        expiresOn,
        contentDisposition: `attachment; filename="${downloadName}"`,
        // Optional: mitigate clock skew by allowing immediate use
        // startsOn: new Date(Date.now() - 2 * 60 * 1000),
      },
      cred
    ).toString();

    // URL-encode only when building the URL (NOT when generating the SAS)
    const sasUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURIComponent(blobName)}?${sas}`;

    context.res = {
      status: 302,
      headers: {
        Location: sasUrl,
        "Cache-Control": "private, max-age=30",
      },
    };
  } catch (err) {
    context.log?.error?.(err);
    context.res = { status: 500, body: String(err?.message || err) };
  }
}
