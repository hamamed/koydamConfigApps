/**
 * A small ZIP reader, and a smaller writer.
 *
 * Every Minecraft add-on format is a ZIP with a different extension — .mcpack, .mcaddon,
 * .mcworld, .mctemplate — and the catalogue needs to look inside one at upload time for two
 * reasons: to prove it really is an archive of the shape it claims (rather than something
 * renamed, which the game rejects long after we accepted it), and to lift the pack's own
 * `pack_icon.png` out so a card has artwork without anyone drawing one.
 *
 * ## Why not a library
 *
 * The dependencies here are `sharp` and `better-sqlite3`, both native, both carrying their own
 * rebuild story on deploy. A third native module — or an unmaintained pure-JS one — to read
 * the central directory of a file we already hold entirely in memory is a poor trade. Node
 * ships the hard half already: `zlib.inflateRawSync` is the actual decompressor.
 *
 * ## What it does not do
 *
 * No streaming, no encryption, no ZIP64. ZIP64 is detected and refused with a clear message
 * rather than misread: its sentinel values are `0xffffffff`, which a reader that ignores the
 * extension happily treats as a four-gigabyte offset into a 40 MB buffer. Uploads are capped
 * well below the point where any of that applies.
 *
 * The writer at the bottom exists only for the seeder, and only emits stored entries. Nothing
 * in the request path writes an archive — uploads are stored byte for byte.
 */

import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** The End of Central Directory record is 22 bytes plus a comment of up to 65535. */
const EOCD_MIN = 22;
const EOCD_MAX_SEARCH = 65_557;

/** ZIP64 sentinels. Seeing one means the real value lives in an extra field we do not read. */
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** Ceiling on a single decompressed entry, so a zip bomb cannot exhaust memory. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
    // Everything this module rejects is a bad upload, not a server fault. Carrying the status
    // means the route can pass it straight to the error handler and the admin sees the reason
    // rather than "something went wrong".
    this.status = 400;
  }
}

/**
 * A cheap check on the first four bytes.
 *
 * Not proof — the full read below is that — but it separates "this is not a ZIP at all" from
 * "this is a ZIP whose contents are wrong", which are different messages to show someone.
 * An empty archive legitimately starts with the EOCD signature instead.
 */
export function looksLikeZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const signature = buffer.readUInt32LE(0);
  return signature === SIG_LOCAL || signature === SIG_EOCD;
}

/**
 * Parses the central directory and returns the entry list.
 *
 * The central directory is read rather than the local headers, because a local header may
 * carry zeroed sizes with the real ones in a trailing data descriptor. The central directory
 * always has them.
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) {
    throw new ZipError('That file is too small to be an archive.');
  }

  const eocd = findEndOfCentralDirectory(buffer);

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (totalEntries === U16_MAX || directorySize === U32_MAX || directoryOffset === U32_MAX) {
    throw new ZipError(
      'That archive uses the ZIP64 extension, which this catalogue cannot read. '
      + 'Re-save it with ordinary ZIP compression.',
    );
  }

  if (directoryOffset + directorySize > buffer.length) {
    throw new ZipError('That archive is truncated — its index points past the end of the file.');
  }

  const entries = [];
  let cursor = directoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length) {
      throw new ZipError('That archive is truncated — its index ends mid-entry.');
    }
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new ZipError('That archive is damaged — its index is not where it says it is.');
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    entries.push({
      name,
      // Entries whose name ends in a slash are directories, with no data of their own.
      isDirectory: name.endsWith('/'),
      method,
      size,
      compressedSize,
      localOffset,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, totalEntries };
}

/**
 * Walks backwards for the End of Central Directory signature.
 *
 * Backwards because the record is last, and only *nearly* last: it may be followed by a
 * comment of up to 64 KB. Searching forwards from the start would find the signature inside
 * a compressed entry that happens to contain those four bytes long before finding the real one.
 */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - EOCD_MAX_SEARCH);

  for (let offset = buffer.length - EOCD_MIN; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) continue;

    // A comment length that does not reach exactly the end of the file means this signature
    // is a coincidence inside the archive's own data, not the record.
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN + commentLength === buffer.length) return offset;
  }

  throw new ZipError(
    'That file is not a ZIP archive. Every Minecraft pack format (.mcpack, .mcaddon, '
    + '.mcworld) is one, so this is likely a renamed file.',
  );
}

/** The first entry whose path matches, ignoring case and any leading directories. */
export function findEntry(zip, matcher) {
  return zip.entries.find((entry) => !entry.isDirectory && matcher(entry.name.toLowerCase(), entry))
    || null;
}

/** Every entry whose path matches. */
export function findEntries(zip, matcher) {
  return zip.entries.filter((entry) => !entry.isDirectory && matcher(entry.name.toLowerCase(), entry));
}

/**
 * Decompresses one entry.
 *
 * The size ceiling is checked against the *declared* size before inflating and enforced again
 * by zlib while it works. Both are needed: the declared size is attacker-controlled, and
 * trusting it alone is exactly how a zip bomb gets through, while checking only afterwards
 * means the memory has already been allocated.
 */
export function extractEntry(buffer, entry, maxBytes = MAX_ENTRY_BYTES) {
  if (entry.isDirectory) return Buffer.alloc(0);

  if (entry.size > maxBytes) {
    throw new ZipError(`'${entry.name}' inside that archive is larger than this reader allows.`);
  }

  const header = entry.localOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== SIG_LOCAL) {
    throw new ZipError(`That archive is damaged — '${entry.name}' is not where its index says.`);
  }

  // The local header's name and extra lengths are read again rather than reused from the
  // central directory: the extra field is routinely a different length in the two places,
  // and using the central one puts the read a few bytes into the compressed data.
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;

  if (end > buffer.length) {
    throw new ZipError(`That archive is truncated — '${entry.name}' runs past the end of the file.`);
  }

  const compressed = buffer.subarray(start, end);

  if (entry.method === 0) return Buffer.from(compressed);

  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch {
      throw new ZipError(`'${entry.name}' inside that archive could not be decompressed.`);
    }
  }

  throw new ZipError(
    `'${entry.name}' uses an unusual compression method. Re-save the archive with `
    + 'ordinary ZIP compression (deflate).',
  );
}

/**
 * Reads an entry as JSON, tolerating what Minecraft's own files contain.
 *
 * Bedrock manifests are hand-edited and routinely ship with a UTF-8 byte-order mark, `//`
 * comments and a trailing comma before a closing brace. The game's parser accepts all three;
 * `JSON.parse` accepts none of them. Refusing a pack the game would load would make this
 * catalogue stricter than Minecraft, which is the wrong kind of strict.
 */
export function readJsonEntry(buffer, entry) {
  const text = extractEntry(buffer, entry)
    .toString('utf8')
    .replace(/^﻿/, '')
    // Only comments that start a line or follow whitespace, so a `//` inside a URL survives.
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Writing ─────────────────────────────────────────────────────────────────
//
// Only the seeder needs this, and only so that the sample catalogue contains *real* archives:
// a seeded .mcaddon goes through the same inspector a real upload does, which is the only way
// the sample data is worth developing against. Nothing in the request path writes a ZIP.
//
// Stored (uncompressed) entries only. Deflating a 400-byte manifest saves nothing, and a
// writer that only has to emit one compression method is a writer with far less to get wrong.

/** CRC-32, built once. The ZIP format requires it per entry and there is no way around it. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Builds a ZIP from `{ name, data }` entries.
 *
 * Local headers first, then the central directory, then the end record — the same three parts
 * `readZip` above walks in reverse.
 */
export function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(0, 8);        // method: stored
    local.writeUInt16LE(0, 10);       // mod time
    local.writeUInt16LE(0x21, 12);    // mod date — 1 Jan 1980, the format's zero
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);       // extra length

    locals.push(local, name, data);

    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(SIG_CENTRAL, 0);
    entryHeader.writeUInt16LE(20, 4);
    entryHeader.writeUInt16LE(20, 6);
    entryHeader.writeUInt16LE(0, 8);
    entryHeader.writeUInt16LE(0, 10);
    entryHeader.writeUInt16LE(0, 12);
    entryHeader.writeUInt16LE(0x21, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(data.length, 20);
    entryHeader.writeUInt32LE(data.length, 24);
    entryHeader.writeUInt16LE(name.length, 28);
    entryHeader.writeUInt16LE(0, 30);  // extra
    entryHeader.writeUInt16LE(0, 32);  // comment
    entryHeader.writeUInt16LE(0, 34);  // disk
    entryHeader.writeUInt16LE(0, 36);  // internal attrs
    entryHeader.writeUInt32LE(0, 38);  // external attrs
    entryHeader.writeUInt32LE(offset, 42);

    central.push(entryHeader, name);
    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}
