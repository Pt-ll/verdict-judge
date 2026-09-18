import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PROBLEM_FILE,
  dataFilePath,
  findProblemRoot,
  loadProblem,
  normalizeTestPath,
  resolveTestPath,
  saveProblem,
  sharedDataDir,
} from '../src/core/problem/package';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-problem-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let packageCounter = 0;

/** 造一个题目包目录；files 的键是相对题目包根目录的路径。 */
function makePackage(files: Record<string, string>): string {
  const dir = path.join(workDir, `pkg-${packageCounter++}`);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

function problemJson(body: Record<string, unknown>): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

const BASE_PROBLEM = {
  version: 1,
  id: 'A',
  name: 'A. 求和',
  type: 'traditional',
  limits: { timeMs: 2000, memoryMb: 512, stackMb: 512, outputKb: 1024 },
  comparator: { mode: 'real', absEps: 1e-6, relEps: 1e-6 },
};

describe('loadProblem', () => {
  it('读出题目、限制、比较方式与测试点', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: problemJson({
        ...BASE_PROBLEM,
        subtasks: [
          { id: '1', points: 30, tests: ['1', '2'], dependsOn: [], scoring: 'min' },
          { id: '2', points: 70, tests: ['3'], dependsOn: ['1'], scoring: 'sum' },
        ],
        tests: [
          { id: '1', input: 'data/1.in', answer: 'data/1.out', points: 10, subtask: '1' },
          { id: '2', input: 'data/2.in', answer: 'data/2.out', points: 20, subtask: '1' },
          { id: '3', input: 'data/3.in', answer: 'data/3.ans', points: 70, subtask: '2' },
        ],
      }),
    });

    const pkg = await loadProblem(dir);

    expect(pkg.problem.id).toBe('A');
    expect(pkg.problem.name).toBe('A. 求和');
    expect(pkg.problem.limits).toEqual({
      timeMs: 2000,
      memoryMb: 512,
      stackMb: 512,
      outputKb: 1024,
    });
    expect(pkg.problem.comparator).toEqual({ mode: 'real', absEps: 1e-6, relEps: 1e-6 });
    expect(pkg.problem.subtasks).toHaveLength(2);
    expect(pkg.problem.subtasks[1]?.scoring).toBe('sum');
    expect(pkg.problem.tests.map((test) => test.id)).toEqual(['1', '2', '3']);
    expect(pkg.dataDir).toBe(path.join(dir, 'data'));
    expect(pkg.extraDir).toBe(path.join(dir, 'extra'));

    // 测试点路径相对题目包根目录，不是相对 data/。
    const first = pkg.problem.tests[0];
    expect(first && resolveTestPath(pkg, first)).toEqual({
      inputPath: path.join(dir, 'data', '1.in'),
      answerPath: path.join(dir, 'data', '1.out'),
    });
  });

  it('没写 tests 时扫描 data/，并保持数字顺序', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: problemJson(BASE_PROBLEM),
      'data/10.in': '10\n',
      'data/10.out': '10\n',
      'data/2.in': '2\n',
      // 只给 .ans：答案文件的后缀允许是 .out / .ans / .expected。
      'data/2.ans': '2\n',
    });

    const pkg = await loadProblem(dir);

    expect(pkg.problem.tests.map((test) => test.id)).toEqual(['2', '10']);
    // 路径相对数据目录；0.1.2 写的 "data/2.in" 在加载时就归一成这种形态。
    expect(pkg.problem.tests.map((test) => test.input)).toEqual(['2.in', '10.in']);
    expect(pkg.problem.tests.map((test) => test.answer)).toEqual(['2.ans', '10.out']);
  });

  it('子任务没写 tests 时，用测试点的 subtask 字段补出来', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: problemJson({
        ...BASE_PROBLEM,
        subtasks: [{ id: '1', points: 100 }],
        tests: [
          { id: '1', input: 'data/1.in', answer: 'data/1.out', subtask: '1' },
          { id: '2', input: 'data/2.in', answer: 'data/2.out' },
        ],
      }),
    });

    const pkg = await loadProblem(dir);

    expect(pkg.problem.subtasks[0]?.tests).toEqual(['1']);
    expect(pkg.problem.subtasks[0]?.dependsOn).toEqual([]);
    // 两种写法都不写时用 min，符合 OI「组内全对才给分」的惯例。
    expect(pkg.problem.subtasks[0]?.scoring).toBe('min');
  });

  it('只有一个空目录也不会报错：新建的题目包还没有数据是正常的', async () => {
    const dir = makePackage({ [PROBLEM_FILE]: problemJson({ id: 'fresh' }) });

    const pkg = await loadProblem(dir);

    expect(pkg.problem.id).toBe('fresh');
    expect(pkg.problem.tests).toEqual([]);
    expect(pkg.problem.subtasks).toEqual([]);
    expect(pkg.problem.limits.timeMs).toBe(1000);
  });
});

describe('测试数据总库（.verdict/data/<题目 id>）', () => {
  /** 造一个工作区：题目包在 .verdict/problems/A，数据按 files 放到指定位置。 */
  function makeVerdictWorkspace(files: Record<string, string>): string {
    const root = path.join(workDir, `verdict-${packageCounter++}`);
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    return root;
  }

  it('题目包在 .verdict/problems/A 时，数据目录落在 .verdict/data/A', async () => {
    const root = makeVerdictWorkspace({
      '.verdict/problems/A/problem.json': problemJson({
        id: 'A',
        tests: [{ id: '1', input: '1.in', answer: '1.out', points: 100 }],
      }),
      '.verdict/data/A/1.in': '1 2\n',
      '.verdict/data/A/1.out': '3\n',
    });

    const pkg = await loadProblem(path.join(root, '.verdict', 'problems', 'A'));

    expect(pkg.dataDir).toBe(path.join(root, '.verdict', 'data', 'A'));
    const first = pkg.problem.tests[0];
    expect(first && resolveTestPath(pkg, first)).toEqual({
      inputPath: path.join(root, '.verdict', 'data', 'A', '1.in'),
      answerPath: path.join(root, '.verdict', 'data', 'A', '1.out'),
    });
  });

  it('没写 tests 时从总库里扫描，路径相对数据目录', async () => {
    const root = makeVerdictWorkspace({
      '.verdict/problems/A/problem.json': problemJson({ id: 'A' }),
      '.verdict/data/A/1.in': '1\n',
      '.verdict/data/A/1.out': '1\n',
      '.verdict/data/A/2.in': '2\n',
      '.verdict/data/A/2.out': '2\n',
    });

    const pkg = await loadProblem(path.join(root, '.verdict', 'problems', 'A'));

    expect(pkg.problem.tests.map((test) => test.id)).toEqual(['1', '2']);
    expect(pkg.problem.tests.map((test) => test.input)).toEqual(['1.in', '2.in']);
  });

  it('包内 data/ 优先于总库：老工作区不会因为总库存在就换数据', async () => {
    const root = makeVerdictWorkspace({
      '.verdict/problems/A/problem.json': problemJson({ id: 'A' }),
      '.verdict/problems/A/data/1.in': 'old\n',
      '.verdict/problems/A/data/1.out': 'old\n',
      '.verdict/data/A/1.in': 'new\n',
      '.verdict/data/A/1.out': 'new\n',
    });

    const pkg = await loadProblem(path.join(root, '.verdict', 'problems', 'A'));

    expect(pkg.dataDir).toBe(path.join(root, '.verdict', 'problems', 'A', 'data'));
    expect(fs.readFileSync(dataFilePath(pkg, '1.in'), 'utf8')).toBe('old\n');
  });

  it('problem.json 写了 dataDir 就听它的（相对题目包根目录）', async () => {
    const root = makeVerdictWorkspace({
      '.verdict/problems/A/problem.json': problemJson({
        id: 'A',
        dataDir: '../../shared/A',
        tests: [{ id: '1', input: '1.in', answer: '1.out' }],
      }),
      '.verdict/shared/A/1.in': 'x\n',
      '.verdict/shared/A/1.out': 'x\n',
    });

    const pkg = await loadProblem(path.join(root, '.verdict', 'problems', 'A'));

    expect(pkg.dataDir).toBe(path.join(root, '.verdict', 'shared', 'A'));
  });

  it('题目包不在 .verdict/problems 下时没有总库可言，退回包内 data/', async () => {
    const dir = makePackage({ [PROBLEM_FILE]: problemJson({ id: 'A' }) });

    const pkg = await loadProblem(dir);

    expect(sharedDataDir(dir)).toBeNull();
    expect(pkg.dataDir).toBe(path.join(dir, 'data'));
  });

  it('0.1.2 的 "data/1.in" 写法被归一成数据目录里的 "1.in"，读写都还指向同一个文件', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: problemJson({
        id: 'A',
        tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
      }),
      'data/1.in': '1 2\n',
      'data/1.out': '3\n',
    });
    const pkg = await loadProblem(dir);

    expect(pkg.problem.tests[0]?.input).toBe('1.in');
    const first = pkg.problem.tests[0];
    expect(first && resolveTestPath(pkg, first).inputPath).toBe(path.join(dir, 'data', '1.in'));

    // 存回去之后还是能读，文件内容不变。
    await saveProblem(pkg);
    const reloaded = await loadProblem(dir);
    expect(reloaded.problem.tests[0]?.input).toBe('1.in');
    expect(fs.readFileSync(path.join(dir, 'data', '1.in'), 'utf8')).toBe('1 2\n');
  });

  it('normalizeTestPath 只剥开头那一段 data/，别的原样保留', () => {
    expect(normalizeTestPath('data/1.in')).toBe('1.in');
    expect(normalizeTestPath('DATA\\1.in')).toBe('1.in');
    expect(normalizeTestPath('./data/1.in')).toBe('./data/1.in');
    expect(normalizeTestPath('sub/1.in')).toBe('sub/1.in');
  });
});

describe('loadProblem 的报错', () => {
  async function expectLoadError(body: Record<string, unknown>): Promise<string> {
    const dir = makePackage({ [PROBLEM_FILE]: problemJson(body) });
    const error = await loadProblem(dir).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(error).not.toBeNull();
    return error ?? '';
  }

  it('一次列出所有问题，而不是只报第一个', async () => {
    const message = await expectLoadError({
      ...BASE_PROBLEM,
      limits: { timeMs: 'fast' },
      subtasks: [{ id: '1', points: 30, tests: ['nope'] }],
      tests: [{ id: '1', answer: 'data/1.out' }],
    });

    expect(message).toContain('3 处问题');
    expect(message).toContain('limits.timeMs');
    expect(message).toContain('子任务 "1" 引用了不存在的测试点 "nope"');
    expect(message).toContain('测试点 "1" 缺少 input');
  });

  it('指出两边说法不一致的测试点归属', async () => {
    const message = await expectLoadError({
      ...BASE_PROBLEM,
      subtasks: [{ id: '1', points: 30, tests: ['1'] }],
      tests: [{ id: '2', input: 'data/2.in', answer: 'data/2.out', subtask: '1' }],
    });

    expect(message).toContain('两边要一致');
  });

  it('依赖成环时报出环上的子任务', async () => {
    const message = await expectLoadError({
      ...BASE_PROBLEM,
      subtasks: [
        { id: '1', points: 50, tests: ['1'], dependsOn: ['2'] },
        { id: '2', points: 50, tests: ['1'], dependsOn: ['1'] },
      ],
      tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
    });

    expect(message).toContain('成环');
  });

  it('空子任务会被指出来', async () => {
    const message = await expectLoadError({
      ...BASE_PROBLEM,
      subtasks: [{ id: '1', points: 30 }],
      tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
    });

    expect(message).toContain('子任务 "1" 没有任何测试点');
  });

  it('不是 JSON 时给出文件名', async () => {
    const dir = makePackage({ [PROBLEM_FILE]: '{ oops' });
    const error = await loadProblem(dir).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(error).toContain('不是合法 JSON');
  });
});

describe('saveProblem', () => {
  it('保留未知字段、覆盖已知字段，并写成 LF 结尾的 JSON', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: problemJson({ ...BASE_PROBLEM, customNote: '别丢了我', version: 99 }),
    });
    const pkg = await loadProblem(dir);
    pkg.problem.name = '改过的名字';
    pkg.problem.tests = [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }];

    await saveProblem(pkg);

    const text = fs.readFileSync(path.join(dir, PROBLEM_FILE), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);

    const reloaded = await loadProblem(dir);
    expect(reloaded.problem.name).toBe('改过的名字');
    expect(reloaded.problem.tests).toHaveLength(1);
    // 未知字段没丢，version 被已知字段覆盖回 1。
    expect(reloaded.problem._raw?.customNote).toBe('别丢了我');
    expect(reloaded.problem._raw?.version).toBe(1);
  });
});

describe('findProblemRoot', () => {
  it('从子目录向上找到最近的题目包', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: problemJson(BASE_PROBLEM),
      'players/alice/A/solve.cpp': 'int main() {}',
    });

    const found = await findProblemRoot(path.join(dir, 'players', 'alice', 'A'), dir);

    expect(found).toBe(dir);
  });

  it('不越过 stopDir，也不在题目包之外乱找', async () => {
    const outside = makePackage({ 'players/alice/A/solve.cpp': 'int main() {}' });

    expect(await findProblemRoot(path.join(outside, 'players'), outside)).toBeNull();
  });
});
