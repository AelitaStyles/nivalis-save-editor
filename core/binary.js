// Low-level helpers for the .NET BinaryWriter-style encoding used by Nivalis Nights saves.
// Everything works on Uint8Array + DataView so it runs both in Node and in the Tauri webview.

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

export function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function readInt32(bytes, pos) {
  return view(bytes).getInt32(pos, true);
}

export function writeInt32(bytes, pos, value) {
  view(bytes).setInt32(pos, value, true);
}

export function readFloat32(bytes, pos) {
  return view(bytes).getFloat32(pos, true);
}

export function writeFloat32(bytes, pos, value) {
  view(bytes).setFloat32(pos, value, true);
}

// 7-bit encoded length prefix followed by UTF-8 bytes (System.IO.BinaryWriter.Write(string)).
export function readString(bytes, pos) {
  let length = 0;
  let shift = 0;
  let b;
  const start = pos;
  do {
    if (pos >= bytes.length || shift > 28) throw new RangeError(`Bad string length prefix at 0x${start.toString(16)}`);
    b = bytes[pos++];
    length |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  if (pos + length > bytes.length) throw new RangeError(`String at 0x${start.toString(16)} runs past end of file`);
  return { value: utf8Decoder.decode(bytes.subarray(pos, pos + length)), start, end: pos + length };
}

export function encodeString(value) {
  const body = utf8Encoder.encode(value);
  const prefix = [];
  let n = body.length;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    prefix.push(b);
  } while (n);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

export function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

// Byte-sequence search (like Buffer.indexOf) without depending on Node's Buffer.
export function indexOf(bytes, needle, from = 0) {
  const first = needle[0];
  const last = bytes.length - needle.length;
  outer: for (let i = bytes.indexOf(first, from); i !== -1 && i <= last; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
