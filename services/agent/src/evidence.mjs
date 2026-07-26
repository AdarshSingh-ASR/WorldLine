import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

export async function archiveReceipt(config, receipt) {
  const body = JSON.stringify(receipt, null, 2);
  const contentHash = createHash("sha256").update(body).digest("hex");
  if (!config.receiptBucket) return { contentHash, archived: false };
  const client = new S3Client({ region: config.awsRegion });
  await client.send(
    new PutObjectCommand({
      Bucket: config.receiptBucket,
      Key: `receipts/${receipt.receiptId}.json`,
      Body: body,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      Metadata: { sha256: contentHash },
    }),
  );
  return { contentHash, archived: true };
}
