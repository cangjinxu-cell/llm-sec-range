/**
 * Zstandard frame container primitives for DSH session logs.
 *
 * A DSH session artifact is a *concatenation of independent Zstandard frames*:
 * the first frame holds only the JSON header line, and every later frame holds
 * one durable append batch of JSONL event rows. Node's one-shot
 * `zstdDecompressSync()` stops after the first frame, so reading a real session
 * log requires walking the frames structurally first.
 *
 * `scanZstdFrames()` is a faithful re-implementation of the scanner DSH itself
 * uses (`@deepseek-ai/dsh-session-persistence-jsonl`, `src/zstd.ts`): it reads
 * frame headers and block headers without decompressing, so it can also report
 * the start of a *torn* (interrupted) final frame, which is exactly what a
 * crash mid-append leaves behind.
 *
 * @module dsh-sessions-diagnosis/core/frames
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

/** Zstandard frame magic number (little-endian `0xFD2FB528`). */
export const ZSTD_MAGIC = 4247762216

/** Compression options DSH uses: one checksummed frame per write. */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Body bytes per emitted frame when re-encoding (DSH's own 1 MiB work slice). */
const FRAME_TARGET_BYTES = 1024 * 1024

/**
 * One complete frame's byte range inside a concatenated stream.
 * @typedef {{ start: number, end: number }} ZstdFrameRange
 */

/**
 * Locate structurally complete Zstandard frames without decompressing blocks.
 *
 * Invalid complete structure throws (the file is not a DSH session log at all).
 * EOF inside the final frame returns its start offset as `tornStart` instead of
 * throwing, because a torn tail is a recoverable crash artifact rather than
 * corruption.
 *
 * @param {Buffer} buffer - complete bytes currently present in the artifact.
 * @param {number} [maxFrames] - optional complete-frame limit for metadata-only readers.
 * @returns {{ frames: ZstdFrameRange[], tornStart?: number }} complete frames in file order.
 * @throws {Error} when a complete frame's structure is invalid.
 */
export function scanZstdFrames (buffer, maxFrames = Number.POSITIVE_INFINITY) {
  /** @type {ZstdFrameRange[]} */
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Decompress one structurally complete frame, validating its checksum.
 * @param {Buffer} frameBytes - exact bytes of a single frame.
 * @returns {Buffer} the frame's plaintext.
 */
export function decompressFrame (frameBytes) {
  return zstdDecompressSync(frameBytes)
}

/**
 * Compress one independently decodable, checksummed frame.
 * @param {Buffer|string} input - JSONL bytes for a header or one event batch.
 * @returns {Buffer} the complete encoded frame.
 */
export function compressFrame (input) {
  return zstdCompressSync(typeof input === 'string' ? Buffer.from(input, 'utf8') : input, CHECKSUM_OPTIONS)
}

/**
 * A decoded session log.
 * @typedef {object} DecodedLog
 * @property {Buffer} bytes - the raw file bytes.
 * @property {ZstdFrameRange[]} frames - structurally complete frames.
 * @property {number|undefined} tornStart - start of an incomplete final frame, if any.
 * @property {number} badFrames - frames whose decompression or checksum failed.
 * @property {Array<{ frame: number, message: string }>} frameErrors - per-frame failures.
 * @property {string} text - concatenated plaintext of every readable frame.
 * @property {unknown[]} rows - parsed JSON rows (header first).
 * @property {Array<{ index: number, line: string, message: string }>} rowErrors - unparseable lines.
 */

/**
 * Decode every readable frame of a session artifact and parse its JSONL rows.
 *
 * Tolerant by design: a frame that fails to decompress, or a line that is not
 * JSON, is recorded as an error and skipped rather than aborting the read. The
 * caller decides what a given error means. Missing the *header* row, however, is
 * fatal — nothing downstream can be interpreted without it.
 *
 * @param {string} path - absolute path to a `session[.vN].jsonl[.zstd]` artifact.
 * @returns {DecodedLog} the decoded log.
 * @throws {Error} when the file is unreadable, has no frames, or has no parseable header row.
 */
export function readSessionLog (path) {
  const bytes = readFileSync(path)
  return decodeSessionLog(bytes, path)
}

/**
 * Decode session-log bytes already in memory (see {@link readSessionLog}).
 * @param {Buffer} bytes - raw artifact bytes.
 * @param {string} [path] - the artifact's path, used only in error messages.
 * @returns {DecodedLog} the decoded log.
 */
export function decodeSessionLog (bytes, path = '<buffer>') {
  const { frames, tornStart } = scanZstdFrames(bytes)
  const parts = []
  const frameErrors = []
  for (let i = 0; i < frames.length; i++) {
    const range = frames[i]
    try {
      parts.push(decompressFrame(bytes.subarray(range.start, range.end)))
    } catch (error) {
      frameErrors.push({ frame: i, message: error instanceof Error ? error.message : String(error) })
    }
  }
  const text = Buffer.concat(parts).toString('utf8')

  const rowErrors = []
  const rows = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      rowErrors.push({ index: i, line, message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (rows.length === 0) {
    throw new Error(`${path}: no readable session rows (${frames.length} frame(s), ${frameErrors.length} undecodable)`)
  }

  return { bytes, frames, tornStart, badFrames: frameErrors.length, frameErrors, text, rows, rowErrors }
}

/**
 * Read only the first frame of an artifact and parse its JSON header row.
 *
 * This is the cheap path DSH's own `list`/`stat` take: listing must not start a
 * migration or read event rows, and neither should a store census.
 *
 * @param {string} path - absolute path to a session artifact.
 * @returns {{ header: any, frameBytes: number, totalBytes: number }} the parsed header and sizes.
 * @throws {Error} when the first frame is missing, undecodable, or not a JSON object.
 */
export function readSessionHeader (path) {
  const bytes = readFileSync(path)
  const { frames } = scanZstdFrames(bytes, 1)
  if (frames.length === 0) throw new Error(`${path}: no complete Zstandard frame`)
  const text = decompressFrame(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8')
  const line = text.split('\n', 1)[0]
  const header = JSON.parse(line)
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new Error(`${path}: first line is not a JSON object`)
  }
  return { header, frameBytes: frames[0].end - frames[0].start, totalBytes: bytes.length }
}

/**
 * Encode JSONL rows as a concatenated-frame session artifact.
 *
 * The layout mirrors what DSH itself publishes: one frame containing only the
 * header line, then one frame per body batch. Body rows are packed up to
 * {@link FRAME_TARGET_BYTES} per frame and each frame always ends on a line
 * boundary, so the result stays readable by the same scanner that reads a
 * natively written log.
 *
 * @param {unknown[]} rows - rows to write; `rows[0]` is the header.
 * @returns {Buffer} the encoded artifact.
 */
export function encodeSessionLog (rows) {
  if (rows.length === 0) throw new Error('encodeSessionLog: at least one row (the header) is required')
  const chunks = [compressFrame(`${JSON.stringify(rows[0])}\n`)]

  let batch = []
  let batchBytes = 0
  const flush = () => {
    if (batch.length === 0) return
    chunks.push(compressFrame(`${batch.join('\n')}\n`))
    batch = []
    batchBytes = 0
  }
  for (let i = 1; i < rows.length; i++) {
    const line = JSON.stringify(rows[i])
    batch.push(line)
    batchBytes += line.length + 1
    if (batchBytes >= FRAME_TARGET_BYTES) flush()
  }
  flush()

  return Buffer.concat(chunks)
}
