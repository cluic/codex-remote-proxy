const MAX_BOUNDARY_BYTES = 70;
const MAX_PART_HEADER_BYTES = 64 * 1024;
const MAX_PARTS = 1024;
const MAX_MODEL_BYTES = 512;
const MAX_MODEL_CODE_POINTS = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,\-./:=? ]+$/;
const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function validModel(value) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value) <= MAX_MODEL_BYTES
    && [...value].length <= MAX_MODEL_CODE_POINTS
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function unquoteParameter(value) {
  if (!value.startsWith('"')) return TOKEN_PATTERN.test(value) ? value : null;
  if (value.length < 2 || !value.endsWith('"')) return null;
  let result = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      if (index >= value.length - 1) return null;
      const escaped = value[index];
      if (escaped !== "\\" && escaped !== '"') return null;
      result += escaped;
    } else if (character === '"' || character.charCodeAt(0) < 0x20
      || character.charCodeAt(0) === 0x7f) {
      return null;
    } else {
      result += character;
    }
  }
  return result;
}

function parameterSegments(value) {
  const segments = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ";") {
      segments.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  segments.push(value.slice(start).trim());
  return segments;
}

function parseParameterizedValue(value) {
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) return null;
  const segments = parameterSegments(value);
  if (!segments || segments.length === 0 || segments[0].length === 0) return null;
  const parameters = new Map();
  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf("=");
    if (equals <= 0) return null;
    const name = segment.slice(0, equals).trim().toLowerCase();
    const rawValue = segment.slice(equals + 1).trim();
    if (!TOKEN_PATTERN.test(name) || parameters.has(name)) return null;
    const decoded = unquoteParameter(rawValue);
    if (decoded === null) return null;
    parameters.set(name, decoded);
  }
  return { value: segments[0].toLowerCase(), parameters };
}

function multipartBoundary(contentType) {
  const parsed = parseParameterizedValue(contentType);
  if (!parsed || parsed.value !== "multipart/form-data") return null;
  const boundary = parsed.parameters.get("boundary");
  if (typeof boundary !== "string"
    || Buffer.byteLength(boundary) === 0
    || Buffer.byteLength(boundary) > MAX_BOUNDARY_BYTES
    || !BOUNDARY_PATTERN.test(boundary)
    || boundary.endsWith(" ")) {
    return null;
  }
  return boundary;
}

function partHeaders(headerBlock) {
  let disposition = null;
  let contentType = null;
  for (const line of headerBlock.split("\r\n")) {
    if (line.length === 0 || /^[ \t]/.test(line)) return null;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!TOKEN_PATTERN.test(name)) return null;
    if (name === "content-disposition") {
      if (disposition !== null) return null;
      disposition = parseParameterizedValue(line.slice(colon + 1).trim());
    } else if (name === "content-type") {
      if (contentType !== null) return null;
      contentType = parseParameterizedValue(line.slice(colon + 1).trim());
      if (contentType === null) return null;
    }
  }
  return disposition?.value === "form-data" ? { disposition, contentType } : null;
}

function modelPartIsText(headers) {
  const parameterNames = [...headers.disposition.parameters.keys()];
  if (parameterNames.some((name) => name === "filename" || name.startsWith("filename*"))) {
    return false;
  }
  if (headers.contentType === null) return true;
  if (headers.contentType.value !== "text/plain") return false;
  const parameters = [...headers.contentType.parameters.entries()];
  return parameters.length === 0
    || (parameters.length === 1
      && parameters[0][0] === "charset"
      && parameters[0][1].toLowerCase() === "utf-8");
}

function decodeModel(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_MODEL_BYTES) return null;
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validModel(value) ? value : null;
  } catch {
    return null;
  }
}

export function inspectMultipartModel(body, contentType, { allowIncomplete = false } = {}) {
  if (!Buffer.isBuffer(body)) return { status: "invalid" };
  const boundary = multipartBoundary(contentType);
  if (boundary === null) return { status: "invalid" };
  const delimiter = Buffer.from(`--${boundary}`, "ascii");
  const nextDelimiter = Buffer.concat([Buffer.from("\r\n", "ascii"), delimiter]);
  if (body.length < delimiter.length || !body.subarray(0, delimiter.length).equals(delimiter)) {
    return { status: allowIncomplete ? "incomplete" : "invalid" };
  }

  let cursor = 0;
  let model = null;
  let modelRange = null;
  for (let partCount = 0; partCount < MAX_PARTS; partCount += 1) {
    if (cursor + delimiter.length > body.length
      || !body.subarray(cursor, cursor + delimiter.length).equals(delimiter)) {
      return { status: allowIncomplete ? "incomplete" : "invalid" };
    }
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--", "ascii"))) {
      cursor += 2;
      if (cursor < body.length) {
        if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n", "ascii"))
          || cursor + 2 !== body.length) {
          return { status: "invalid" };
        }
      }
      return model === null
        ? { status: "missing", boundary, closingBoundaryStart: cursor - delimiter.length - 2 }
        : { status: "valid", model, range: modelRange, boundary, complete: true };
    }
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n", "ascii"))) {
      return { status: allowIncomplete ? "incomplete" : "invalid" };
    }
    cursor += 2;
    const headersEnd = body.indexOf(Buffer.from("\r\n\r\n", "ascii"), cursor);
    if (headersEnd === -1) return { status: allowIncomplete ? "incomplete" : "invalid" };
    if (headersEnd - cursor > MAX_PART_HEADER_BYTES) return { status: "invalid" };
    const headers = partHeaders(body.subarray(cursor, headersEnd).toString("latin1"));
    if (headers === null) return { status: "invalid" };
    const dataStart = headersEnd + 4;
    const boundaryStart = body.indexOf(nextDelimiter, dataStart);
    if (boundaryStart === -1) return { status: allowIncomplete ? "incomplete" : "invalid" };
    const fieldName = headers.disposition.parameters.get("name");
    if (fieldName === "model") {
      if (!modelPartIsText(headers) || model !== null) return { status: "invalid" };
      model = decodeModel(body.subarray(dataStart, boundaryStart));
      if (model === null) return { status: "invalid" };
      modelRange = { start: dataStart, end: boundaryStart };
    }
    cursor = boundaryStart + 2;
  }
  return { status: "invalid" };
}

export function rewriteMultipartModel(body, contentType, targetModel, maxBytes) {
  if (!Buffer.isBuffer(body) || !validModel(targetModel)
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return null;
  }
  const inspection = inspectMultipartModel(body, contentType);
  const replacement = Buffer.from(targetModel, "utf8");
  if (inspection.status === "valid") {
    const current = body.subarray(inspection.range.start, inspection.range.end);
    if (current.equals(replacement)) return { body, changed: false, sourceModel: inspection.model };
    const rewrittenLength = body.length - current.length + replacement.length;
    if (rewrittenLength > maxBytes) return { tooLarge: true, sourceModel: inspection.model };
    return {
      body: Buffer.concat([
        body.subarray(0, inspection.range.start),
        replacement,
        body.subarray(inspection.range.end)
      ], rewrittenLength),
      changed: true,
      sourceModel: inspection.model
    };
  }
  if (inspection.status !== "missing") return null;
  const insertedPart = Buffer.from(
    `--${inspection.boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${targetModel}\r\n`,
    "utf8"
  );
  const rewrittenLength = body.length + insertedPart.length;
  if (rewrittenLength > maxBytes) return { tooLarge: true, sourceModel: null };
  return {
    body: Buffer.concat([
      body.subarray(0, inspection.closingBoundaryStart),
      insertedPart,
      body.subarray(inspection.closingBoundaryStart)
    ], rewrittenLength),
    changed: true,
    sourceModel: null
  };
}
