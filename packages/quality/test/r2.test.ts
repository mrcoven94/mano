// R2-2: the SigV4 signer reproduces a genuine AWS CLI signature byte for byte,
// then signs private-bucket reads for the staff page.

// Captured from `aws s3api get-object` against a local stub on 2026-10-29:
// key AKIDEXAMPLE, region us-east-1, path /mybucket/runs/2026-10-28/cases.json.
const CAPTURED_DATE = new Date("2026-10-29T17:30:36.000Z");
const CAPTURED_AUTH = "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261029/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date, Signature=4c625cfe178da0847bce05470d485ce7f8ec71cfce9fc079880c3e05d4c185a0";

import assert from "node:assert/strict";
import test from "node:test";
import { PRIVATE_BUCKET, r2CredsFromEnv, signS3Get, signedPrivateGet } from "../src/r2.ts";

test("signer matches the AWS CLI signature", () => {
  const { authorization, amzDate } = signS3Get({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    host: "127.0.0.1:8199",
    path: "/mybucket/runs/2026-10-28/cases.json",
    date: CAPTURED_DATE,
    extraHeaders: { "x-amz-checksum-mode": "ENABLED" },
  });
  assert.equal(amzDate, "20261029T173036Z");
  assert.equal(authorization, CAPTURED_AUTH);
});

test("private reads target the private bucket with credentials", () => {
  const creds = r2CredsFromEnv({ R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "ak", R2_SECRET_ACCESS_KEY: "sk" });
  assert.ok(creds);
  assert.equal(PRIVATE_BUCKET, "mano-quality-private");
  const signed = signedPrivateGet(creds!, "runs/2026-10-28/cases.json", CAPTURED_DATE);
  assert.equal(signed.url, "https://acct123.r2.cloudflarestorage.com/mano-quality-private/runs/2026-10-28/cases.json");
  assert.match(signed.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=ak\/20261029\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(r2CredsFromEnv({}), null);
});
