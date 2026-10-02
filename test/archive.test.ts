import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile, detectToolchain, type Toolchain } from '../src/core/compiler';
import { exportProblemPackage, importProblemPackage } from '../src/core/problem/archive';
import { loadProblem, resolveTestPath } from '../src/core/problem/package';
import { createZip, extractZip } from '../src/core/zip';
import { judgeProblem } from '../src/core/judge/judge';
import { createSandbox } from '../src/core/sandbox/sandbox';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-archive-'));
const cacheDir = path.join(workDir, 'cache');
const sandbox = createSandbox();

let toolchain: Toolchain | null = null;
let available = false;

beforeAll(async () => {
  toolchain = await detectToolchain();
  available = toolchain !== null && toolchain.kind !== 'python';
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

function makeDir(files: Record<string, string>): string {
  const dir = path.join(workDir, `pkg-${counter++}`);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

/** 一个完整可评测的小题目包：一个测试点、100 分、标准输出比较。 */
function makeSimpleProblem(): string {
  return makeDir({
    'problem.json': JSON.stringify({
      id: 'A',
      name: 'A. 求和',
      limits: { timeMs: 5000, memoryMb: 256, stackMb: 256, outputKb: 4096 },
      tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points: 100 }],
    }),
    'data/1.in': '1 2\n',
    'data/1.out': '3\n',
    'extra/readme.txt': '出题人的备注，导出时不该丢\n',
  });
}

const SUM = [
  '#include <cstdio>',
  'int main() {',
  '  int a = 0, b = 0;',
  '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
  '  std::printf("%d\\n", a + b);',
  '  return 0;',
  '}',
  '',
].join('\n');

describe('题目包导出与导入', () => {
  it('数据在总库里时，导出会把数据一起收进包内的 data/', async () => {
    // 0.1.3 起数据搬到 .verdict/data/<id>：这个包自己不带 data/，导出必须去总库拿。
    const root = path.join(workDir, `ws-${counter++}`);
    const packageDir = path.join(root, '.verdict', 'problems', 'A');
    const dataDir = path.join(root, '.verdict', 'data', 'A');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'problem.json'),
      JSON.stringify({
        id: 'A',
        tests: [{ id: '1', input: '1.in', answer: '1.out', points: 100 }],
      }),
    );
    fs.writeFileSync(path.join(dataDir, '1.in'), '1 2\n');
    fs.writeFileSync(path.join(dataDir, '1.out'), '3\n');

    const pkg = await loadProblem(packageDir);
    const zipPath = path.join(workDir, `shared-${counter++}.zip`);
    const result = await exportProblemPackage(pkg, zipPath);

    const names = extractZip(fs.readFileSync(zipPath)).map((entry) => entry.name);
    expect(names).toContain('problem.json');
    expect(names).toContain('data/1.in');
    expect(names).toContain('data/1.out');
    expect(result.entries).toBeGreaterThanOrEqual(3);

    // 导出的包在别处解开之后，数据在包内，照样能评测。
    const dest = path.join(workDir, `imported-${counter++}`);
    fs.mkdirSync(dest, { recursive: true });
    const imported = await importProblemPackage(zipPath, dest);
    expect(imported.package.dataDir).toBe(path.join(imported.rootDir, 'data'));
    expect(fs.readFileSync(path.join(imported.rootDir, 'data', '1.in'), 'utf8')).toBe('1 2\n');
  });

  it('导出的包导入到新工作区后能直接评测（M4 验收）', async () => {
    const source = makeSimpleProblem();
    const zipPath = path.join(workDir, 'A.zip');

    const exported = await exportProblemPackage(await loadProblem(source), zipPath);
    expect(exported.entries).toBe(4);
    expect(fs.existsSync(zipPath)).toBe(true);

    const destinationRoot = path.join(workDir, 'another-workspace', 'problems');
    const imported = await importProblemPackage(zipPath, destinationRoot);

    expect(imported.package.problem.id).toBe('A');
    expect(imported.rootDir).toBe(path.join(destinationRoot, 'A'));
    // extra/ 里的东西也要跟着走：checker、std、出题人备注都在那儿。
    expect(fs.readFileSync(path.join(imported.rootDir, 'extra', 'readme.txt'), 'utf8')).toContain(
      '出题人的备注',
    );

    if (!available || toolchain === null) {
      return;
    }
    const sourcePath = path.join(workDir, 'solve.cpp');
    fs.writeFileSync(sourcePath, SUM);
    const compiled = await compile(toolchain, sourcePath, { cacheDir });
    expect(compiled.ok).toBe(true);

    const result = await judgeProblem(imported.package, {
      runCmd: compiled.runCmd,
      toolchain,
      sandbox,
      cacheDir,
    });

    expect(result.cases[0]?.verdict).toBe('AC');
    expect(result.score).toBe(100);
    // 测试点路径仍然相对题目包根目录，换台机器/换个目录都不会失效。
    const first = imported.package.problem.tests[0];
    expect(first !== undefined && resolveTestPath(imported.package, first).inputPath).toBe(
      path.join(imported.rootDir, 'data', '1.in'),
    );
  });

  it('目标目录已存在时拒绝导入，不覆盖别人的数据', async () => {
    const source = makeSimpleProblem();
    const zipPath = path.join(workDir, 'A-again.zip');
    await exportProblemPackage(await loadProblem(source), zipPath);
    const destinationRoot = path.join(workDir, 'occupied');
    fs.mkdirSync(path.join(destinationRoot, 'A'), { recursive: true });
    fs.writeFileSync(path.join(destinationRoot, 'A', '我的笔记.txt'), '别删我');

    await expect(importProblemPackage(zipPath, destinationRoot)).rejects.toThrow(/已经存在/);
    // 拒绝之后，原来的东西必须原封不动。
    expect(fs.readFileSync(path.join(destinationRoot, 'A', '我的笔记.txt'), 'utf8')).toBe('别删我');
  });

  it('不是题目包的压缩包会被认出来', async () => {
    const zipPath = path.join(workDir, 'not-a-problem.zip');
    fs.writeFileSync(zipPath, createZip([{ name: 'readme.txt', data: Buffer.from('hi') }]));

    await expect(importProblemPackage(zipPath, path.join(workDir, 'x'))).rejects.toThrow(
      /不像一个题目包/,
    );
  });

  it('带 .. 的压缩包在解压前就被拒绝', async () => {
    const zipPath = path.join(workDir, 'evil.zip');
    fs.writeFileSync(
      zipPath,
      createZip([
        { name: 'problem.json', data: Buffer.from('{"id":"A"}', 'utf8') },
        { name: '../evil.txt', data: Buffer.from('我不该出现在目标目录外面') },
      ]),
    );

    await expect(importProblemPackage(zipPath, path.join(workDir, 'y'))).rejects.toThrow(/不安全/);
  });
});
