import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestCase } from '../model';
import { isFile } from '../../util/files';

const INPUT_EXTENSION = '.in';
const ANSWER_EXTENSIONS = ['.out', '.ans', '.expected'];

export interface TestDataLocation {
  /** 测试数据所在目录。 */
  dataDir: string;
  tests: TestCase[];
}

/**
 * 扫描目录下的 *.in 与配对的答案文件。
 *
 * 顺序必须稳定（SPEC §5.8）：用数字感知排序，让 2.in 排在 10.in 前面，
 * 否则测试点的编号与运行顺序会对不上。
 */
export async function scanTests(dataDir: string): Promise<TestCase[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = new Set(
    entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name),
  );

  const tests: TestCase[] = [];
  for (const name of files) {
    if (!name.toLowerCase().endsWith(INPUT_EXTENSION)) {
      continue;
    }
    const id = name.slice(0, -INPUT_EXTENSION.length);
    const answer = ANSWER_EXTENSIONS.map((ext) => `${id}${ext}`).find((candidate) =>
      files.has(candidate),
    );
    if (answer === undefined) {
      continue;
    }
    tests.push({ id, input: name, answer });
  }

  return tests.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/**
 * 为「评测当前文件」找一个可用的测试数据目录（M1 的过渡方案）。
 *
 * 查找顺序：与源文件同名的 .in/.out 配对 → 同级 tests/ 或 test/ → 源文件所在目录。
 * M2 引入题目包后，这里会退居为「没有 problem.json 时的兜底」。
 */
export async function findTestsBesideSource(
  sourcePath: string,
): Promise<TestDataLocation | null> {
  const sourceDir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));

  const sibling = await findSiblingPair(sourceDir, base);
  if (sibling) {
    return { dataDir: sourceDir, tests: [sibling] };
  }

  for (const name of ['tests', 'test']) {
    const dataDir = path.join(sourceDir, name);
    const tests = await scanTests(dataDir);
    if (tests.length > 0) {
      return { dataDir, tests };
    }
  }

  const tests = await scanTests(sourceDir);
  return tests.length > 0 ? { dataDir: sourceDir, tests } : null;
}

/**
 * 把测试点的相对文件名还原成可读写的绝对路径。
 *
 * 只用于 M1 的约定式查找（findTestsBesideSource）：那条路上测试点一律来自文件，
 * 不存在内联样例，所以这里把可选字段当成必填用。
 */
export function resolveTestFiles(
  location: TestDataLocation,
  test: TestCase,
): { inputPath: string; answerPath: string } {
  if (test.input === undefined || test.answer === undefined) {
    throw new Error(`测试点 ${test.id} 没有数据文件（约定式查找只认文件形式）`);
  }
  return {
    inputPath: path.join(location.dataDir, test.input),
    answerPath: path.join(location.dataDir, test.answer),
  };
}

async function findSiblingPair(
  sourceDir: string,
  base: string,
): Promise<TestCase | null> {
  for (const inputName of [`${base}.in`, `${base}.in.txt`]) {
    if (!(await isFile(path.join(sourceDir, inputName)))) {
      continue;
    }
    for (const ext of ANSWER_EXTENSIONS) {
      const answerName = `${base}${ext}`;
      if (await isFile(path.join(sourceDir, answerName))) {
        return { id: base, input: inputName, answer: answerName };
      }
    }
  }
  return null;
}
