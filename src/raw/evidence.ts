// Read source bytes through the same descriptor whose indexed prefix was verified. Appends are allowed;
// a rewrite of that prefix is not. File metadata invalidates the per-descriptor verification cache.
// A zstd source is read and verified as its decompressed bytes.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isCredentialPath, isZstd, openSource, type SourceHandle } from '../adapters/adapter.ts';

export interface SourceFingerprint { sha256: string; bytes: number }

export class VerifiedSource {
  private stamp = '';
  private fh: SourceHandle;
  /** The file's size counts compressed bytes, so it cannot bound the indexed prefix. */
  private compressed: boolean;
  readonly fingerprint?: SourceFingerprint;
  private constructor(fh: SourceHandle, compressed: boolean, fingerprint?: SourceFingerprint) { this.fh = fh; this.compressed = compressed; this.fingerprint = fingerprint; }

  static async open(path: string, fingerprint?: SourceFingerprint): Promise<VerifiedSource> {
    const real = await realpath(path);
    if (isCredentialPath(path) || isCredentialPath(real)) throw new Error('credential sources cannot be read');
    const source = new VerifiedSource(await openSource(real, isZstd(path)), isZstd(path), fingerprint);
    try { await source.verify(); return source; }
    catch (e) { await source.close(); throw e; }
  }

  private async verify(): Promise<void> {
    const st = await this.fh.stat();
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    if (stamp === this.stamp) return;
    const fp = this.fingerprint;
    if (fp) {
      if (!/^[a-f0-9]{64}$/.test(fp.sha256) || !Number.isSafeInteger(fp.bytes) || fp.bytes < 0) throw new Error('invalid indexed source fingerprint');
      if (!this.compressed && st.size < fp.bytes) throw new Error('source file is shorter than its indexed prefix');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(1 << 20, Math.max(1, fp.bytes)));
      for (let offset = 0; offset < fp.bytes;) {
        const { bytesRead } = await this.fh.read(buffer, 0, Math.min(buffer.length, fp.bytes - offset), offset);
        if (!bytesRead) throw new Error('source changed while verifying its indexed prefix');
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (hash.digest('hex') !== fp.sha256) throw new Error('source fingerprint differs from the indexed bytes; reindex before reading raw evidence');
      const after = await this.fh.stat();
      if (`${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) throw new Error('source changed during evidence verification; retry');
    }
    this.stamp = stamp;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new Error('invalid source range');
    if (this.fingerprint && offset + length > this.fingerprint.bytes) throw new Error('raw range exceeds the indexed source prefix');
    await this.verify();
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = (await this.fh.read(bytes, read, length - read, offset + read)).bytesRead;
      if (!n) break;
      read += n;
    }
    await this.verify();
    if (read !== length) throw new Error('source changed since indexing');
    return bytes;
  }

  async close(): Promise<void> { await this.fh.close(); }
}
