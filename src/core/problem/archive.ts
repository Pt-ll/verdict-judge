import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createZip, extractZip, type ZipEntry } from '../zip';
import { loadProblem, PROBLEM_FILE, type ProblemPackage } from './package';

/** 打包时不带上的系统垃圾文件（别的文件一律原样带走，包括 extra/ 里的 checker）。 */
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export interface ExportedArchive {
  zipPath: string;
  entries: number;
  bytes: number;
}

/**
 * 把题目包导出成一个 ZIP（SPEC §5.8 / §6.5）。
 *
 * 条目排序后再打包：同一个题目包每次导出的字节完全一样，便于校验、比对与入库。
 */
export async function exportProblemPackage(
  pkg: ProblemPackage,
  zipPath: string,
): Promise<ExportedArchive> {
  const entries = await collectEntries(pkg.rootDir, '');
  // 数据在总库（.verdict/data/<id>）里时，包内没有 data/ —— 导出必须把它收进来，
  // 并且按约定的包内布局摆在 data/ 下。否则别人拿到这个 ZIP 只有 problem.json，
  // 一条测试数据都没有（0.1.3 起数据搬出题目包之后就一直有这个问题）。
  const localData = path.join(pkg.rootDir, 'data');
  if (path.resolve(pkg.dataDir) !== path.resolve(localData)) {
    // collectEntries 的 prefix 是「从 rootDir 往下走的相对路径」，所以这里走一遍数据目录，
    // 再给每个条目挂上包内的 data/ 前缀。
    const fromLibrary = await collectEntries(pkg.dataDir, '');
    entries.push(...fromLibrary.map((entry) => ({ ...entry, name: `data/${entry.name}` })));
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const zip = createZip(entries);
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.promises.writeFile(zipPath, zip);
  return { zipPath, entries: entries.length, bytes: zip.length };
}

export interface ImportedArchive {
  package: ProblemPackage;
  rootDir: string;
}

/**
 * 从 ZIP 导入题目包到 destRootDir/<题目 id>（SPEC §5.8）。
 *
 * 顺序是刻意的：先解到临时目录并**读一遍**（确认它真的是一个合法题目包），
 * 再搬进目标目录。否则一个坏掉的压缩包会直接铺进 .verdict/problems/，
 * 留下一堆半成品让人猜哪里出了问题。
 */
export async function importProblemPackage(
  zipPath: string,
  destRootDir: string,
): Promise<ImportedArchive> {
  const zip = await fs.promises.readFile(zipPath);
  // extractZip 会在条目路径不安全（带 .. 或绝对路径）时直接拒绝。
  const entries = extractZip(zip);
  if (entries.length === 0) {
    throw new Error(`${zipPath} 是空的`);
  }
  if (!entries.some((entry) => entry.name === PROBLEM_FILE)) {
    throw new Error(`${zipPath} 里没有 ${PROBLEM_FILE}，这不像一个题目包`);
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdict-import-'));
  try {
    for (const entry of entries) {
      // entry.name 用的是一律 '/' 的包内路径，这里按平台拼成本地路径。
      const target = path.join(tempDir, ...entry.name.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, entry.data);
    }

    const preview = await loadProblem(tempDir);
    const destination = path.join(destRootDir, preview.problem.id);
    if (await exists(destination)) {
      // 不覆盖：题目目录里可能有别人正在改的数据，静默盖掉是不可挽回的。
      throw new Error(`目标目录已经存在：${destination}。请先移走或改名，我不会覆盖它。`);
    }
    await fs.promises.mkdir(destRootDir, { recursive: true });
    await moveDir(tempDir, destination);
    return { package: await loadProblem(destination), rootDir: destination };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function collectEntries(rootDir: string, prefix: string): Promise<ZipEntry[]> {
  const dir = prefix.length === 0 ? rootDir : path.join(rootDir, prefix);
  const entries: ZipEntry[] = [];

  for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (JUNK_FILES.has(item.name)) {
      continue;
    }
    const relative = prefix.length === 0 ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      entries.push(...(await collectEntries(rootDir, relative)));
      continue;
    }
    if (item.isFile()) {
      entries.push({ name: relative, data: await fs.promises.readFile(path.join(dir, item.name)) });
    }
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch {
    // 临时目录与工作区可能不在同一个卷上，rename 会失败；退回「复制再删」。
    await fs.promises.cp(from, to, { recursive: true });
    await fs.promises.rm(from, { recursive: true, force: true });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}
