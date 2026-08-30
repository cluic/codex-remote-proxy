import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectMultipartModel,
  rewriteMultipartModel
} from "../src/http/multipart-model.mjs";

function multipartBody(boundary, parts, { close = true } = {}) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}${part.dispositionSuffix ?? ""}\r\n${part.contentType ? `Content-Type: ${part.contentType}\r\n` : ""}\r\n`,
      "utf8"
    ));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, "utf8"));
    chunks.push(Buffer.from("\r\n", "ascii"));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
  return Buffer.concat(chunks);
}

test("multipart model inspection finds a bounded UTF-8 field without decoding image bytes", () => {
  const boundary = "crp-edits-boundary";
  const image = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x80, 0x01]);
  const body = multipartBody(boundary, [
    { name: "image[]", filename: "source.png", contentType: "image/png", value: image },
    { name: "prompt", value: "repair the edge" },
    { name: "model", value: "gpt-image-2" }
  ]);

  const inspection = inspectMultipartModel(
    body,
    `multipart/form-data; boundary="${boundary}"`
  );
  assert.equal(inspection.status, "valid");
  assert.equal(inspection.model, "gpt-image-2");
  assert.deepEqual(body.subarray(inspection.range.start, inspection.range.end), Buffer.from("gpt-image-2"));
  assert.notEqual(body.indexOf(image), -1);
});

test("multipart model inspection rejects missing, duplicate, malformed, and binary model fields", () => {
  const boundary = "crp-invalid-boundary";
  const contentType = `multipart/form-data; boundary=${boundary}`;
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{ name: "prompt", value: "draw" }]),
    contentType
  ).status, "missing");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [
      { name: "model", value: "gpt-image-2" },
      { name: "model", value: "gpt-image-2" }
    ]),
    contentType
  ).status, "invalid");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{ name: "model", filename: "model.txt", value: "gpt-image-2" }]),
    contentType
  ).status, "invalid");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{
      name: "model",
      dispositionSuffix: "; filename*=UTF-8''model.bin",
      value: "gpt-image-2"
    }]),
    contentType
  ).status, "invalid");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{
      name: "model",
      contentType: "application/octet-stream",
      value: "gpt-image-2"
    }]),
    contentType
  ).status, "invalid");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{
      name: "model",
      contentType: "text/plain; charset=utf-8",
      value: "gpt-image-2"
    }]),
    contentType
  ).status, "valid");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{ name: "model", value: Buffer.from([0xc3, 0x28]) }]),
    contentType
  ).status, "invalid");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{ name: "model", value: " gpt-image-2" }]),
    contentType
  ).status, "invalid");
  assert.equal(inspectMultipartModel(
    multipartBody(boundary, [{ name: "model", value: "gpt-image-2" }]),
    "multipart/form-data"
  ).status, "invalid");
});

test("multipart prefix inspection never treats an unclosed body as a unique routing model", () => {
  const boundary = "crp-prefix-boundary";
  const prefix = multipartBody(boundary, [
    { name: "model", value: "gpt-image-2" }
  ], { close: false });
  const imageHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`,
    "ascii"
  );
  const inspection = inspectMultipartModel(
    Buffer.concat([prefix, imageHeader, Buffer.alloc(1024, 0xa5)]),
    `multipart/form-data; boundary=${boundary}`,
    { allowIncomplete: true }
  );
  assert.equal(inspection.status, "incomplete");

  const duplicatePrefix = Buffer.concat([
    prefix,
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n`,
      "ascii"
    ),
    imageHeader,
    Buffer.alloc(1024, 0xa5)
  ]);
  assert.equal(inspectMultipartModel(
    duplicatePrefix,
    `multipart/form-data; boundary=${boundary}`,
    { allowIncomplete: true }
  ).status, "invalid");
});

test("multipart model rewrite changes only the model field and can insert a missing field", () => {
  const boundary = "crp-rewrite-boundary";
  const contentType = `multipart/form-data; boundary=${boundary}`;
  const image = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x7f]);
  const original = multipartBody(boundary, [
    { name: "image", filename: "source.bin", contentType: "application/octet-stream", value: image },
    { name: "model", value: "gpt-image-2" }
  ]);
  const rewritten = rewriteMultipartModel(original, contentType, "vendor/image-edit", 1024 * 1024);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.sourceModel, "gpt-image-2");
  assert.notEqual(rewritten.body.indexOf(image), -1);
  assert.equal(inspectMultipartModel(rewritten.body, contentType).model, "vendor/image-edit");

  const missing = multipartBody(boundary, [
    { name: "image", filename: "source.bin", value: image }
  ]);
  const inserted = rewriteMultipartModel(missing, contentType, "vendor/image-edit", 1024 * 1024);
  assert.equal(inserted.changed, true);
  assert.equal(inserted.sourceModel, null);
  assert.notEqual(inserted.body.indexOf(image), -1);
  assert.equal(inspectMultipartModel(inserted.body, contentType).model, "vendor/image-edit");
  assert.equal(
    rewriteMultipartModel(original, contentType, "vendor/image-edit", original.length)?.tooLarge,
    true
  );
});
