import { createReadStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const TRANSFER_MODES = new Set(["move", "copy", "hardlink"]);

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);
const SIDECAR_EXTENSIONS = [".lrc"];
export const ALBUM_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

async function digest(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function filesIdentical(left, right) {
  const [a, b] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (!a.isFile() || !b.isFile()) return false;
  if (a.dev === b.dev && a.ino === b.ino) return true;
  if (a.size !== b.size) return false;
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  return leftDigest === rightDigest;
}

export async function isSameFile(left, right) {
  const [a, b] = await Promise.all([fs.stat(left), fs.stat(right)]);
  return a.dev === b.dev && a.ino === b.ino;
}

const temporaryPath = (target) =>
  path.join(path.dirname(target), `.aurral-transfer-${process.pid}-${randomUUID()}.tmp`);

async function linkOrRenameNew(from, target) {
  try {
    await fs.link(from, target);
    await fs.unlink(from);
  } catch (error) {
    if (!LINK_UNSUPPORTED.has(error?.code)) throw error;
    if (await fs.lstat(target).catch(() => null)) {
      throw Object.assign(new Error(`File exists: ${target}`), { code: "EEXIST" });
    }
    await fs.rename(from, target);
  }
}

async function copyNew(source, target) {
  const temporary = temporaryPath(target);
  try {
    await fs.copyFile(source, temporary, fsConstants.COPYFILE_FICLONE);
    const [from, to] = await Promise.all([fs.stat(source), fs.stat(temporary)]);
    if (from.size !== to.size) throw new Error("The copy did not match the source size");
    await fs.utimes(temporary, from.atime, from.mtime);
    await linkOrRenameNew(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

// Never replaces an existing target: a taken name fails with EEXIST.
export async function placeFile(source, target, mode) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (mode === "hardlink") {
    await fs.link(source, target);
    return;
  }
  if (mode === "copy") {
    await copyNew(source, target);
    return;
  }
  try {
    await linkOrRenameNew(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await copyNew(source, target);
    await fs.unlink(source);
  }
}

export async function transferSidecars(source, target, mode) {
  const sourceBase = source.slice(0, -path.extname(source).length);
  const targetBase = target.slice(0, -path.extname(target).length);
  for (const extension of SIDECAR_EXTENSIONS) {
    const from = `${sourceBase}${extension}`;
    if (!(await fs.lstat(from).catch(() => null))?.isFile()) continue;
    try {
      await placeFile(from, `${targetBase}${extension}`, mode);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

export async function removeSidecars(filePath) {
  const base = filePath.slice(0, -path.extname(filePath).length);
  for (const extension of SIDECAR_EXTENSIONS) await fs.rm(`${base}${extension}`, { force: true });
}

// A folder that has only album art left once its music is gone goes too.
export async function removeEmptiedFolder(directory, stopAt) {
  const root = path.resolve(stopAt);
  const folder = path.resolve(directory);
  if (!folder.startsWith(`${root}${path.sep}`)) return;
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  if (entries.some((entry) => !entry.isFile() || !ALBUM_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) {
    return;
  }
  for (const entry of entries) await fs.rm(path.join(folder, entry.name), { force: true });
  await removeEmptyDirectories(folder, root);
}

const HARDLINK_REASONS = {
  EXDEV:
    "The source folder and the Downloads Folder are on different filesystems or mounts. In Docker, mount one parent folder that holds both.",
};

export async function probeHardlink(sourceFile, targetDirectory) {
  const probe = path.join(targetDirectory, `.aurral-link-check-${process.pid}-${randomUUID()}`);
  try {
    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.link(sourceFile, probe);
    await fs.unlink(probe);
    return { available: true, reason: null };
  } catch (error) {
    await fs.rm(probe, { force: true }).catch(() => {});
    return {
      available: false,
      reason: HARDLINK_REASONS[error?.code]
        || `This filesystem does not allow hardlinks here (${error?.code || error?.message || "unknown error"}).`,
    };
  }
}

export async function removeEmptyDirectories(directory, stopAt) {
  const root = path.resolve(stopAt);
  let current = path.resolve(directory);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
