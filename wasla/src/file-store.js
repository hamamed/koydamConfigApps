import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Uploaded media on disk: question pictures and question sounds.
 *
 * The file type comes from the first bytes, never from the uploaded name, and
 * the stored name is generated — so nothing a browser sends ends up in a path.
 */
export function createFileStore(root, { maxBytes, sniff, extensions, noun, formats }) {
  const name = new RegExp(`^[a-f0-9]{24}\\.(${extensions.join('|')})$`);

  return {
    root,

    /** Whether a name is one this store could have generated. */
    owns: (file) => Boolean(file && name.test(file)),

    /** Writes a file; `{ file }` on success, `{ error }` with a reason otherwise. */
    async save(buffer) {
      if (!buffer?.length) return { error: `The ${noun} is empty.` };
      if (buffer.length > maxBytes) {
        return { error: `The ${noun} is larger than ${Math.round(maxBytes / 1024 / 1024) || 1} MB.` };
      }
      const ext = sniff(buffer);
      if (!ext) return { error: `${noun[0].toUpperCase()}${noun.slice(1)}s must be ${formats}.` };

      await fs.mkdir(root, { recursive: true });
      const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
      // Written under a temporary name and renamed, so a half-written file is never served.
      const temp = path.join(root, `.${file}.part`);
      await fs.writeFile(temp, buffer);
      await fs.rename(temp, path.join(root, file));
      return { file };
    },

    /** Deletes a file. Anything that is not a generated name is ignored. */
    async remove(file) {
      if (!file || !name.test(file)) return;
      await fs.rm(path.join(root, file), { force: true });
    },
  };
}
