"use strict";
/* sigv4.test.js — the hand-rolled SigV4 signer vs AWS's published test vector.
   Vector: the canonical GET iam.amazonaws.com ListUsers example from the AWS
   "Signature Version 4 signing process" docs (key AKIDEXAMPLE). A matching
   signature here means the whole chain (canonical request → string-to-sign →
   signing key → signature) is correct; a mismatch would 403 at Bedrock. */

const fx = require("./fixtures");
const { signV4 } = require("../agy-anthropic");

const failures = [];

// AWS's documented example — expected values quoted from the official docs.
const creds = { AccessKeyId: "AKIDEXAMPLE", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const out = signV4({
  method: "GET",
  pathName: "/",
  query: "Action=ListUsers&Version=2010-05-08",
  headers: {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    host: "iam.amazonaws.com",
    "x-amz-date": "20150830T123600Z",
  },
  payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // sha256("")
  region: "us-east-1",
  service: "iam",
  amzDate: "20150830T123600Z",
  creds,
});

fx.assert(
  out.signature === "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  "signature matches the AWS reference vector (" + out.signature.slice(0, 12) + "…)",
  failures
);
fx.assert(
  out.authorization ===
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
    "SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  "authorization header assembled exactly per spec",
  failures
);

fx.finish(failures, "sigv4.test");
