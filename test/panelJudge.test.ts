import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { judgeProblem } from '../src/core/judge/judge';
import { DEFAULT_LIMITS } from '../src/core/model';
import { loadProblem, PROBLEM_FILE } from '../src/core/problem/package';
import type { RunResult, Sandbox } from '../src/core/sandbox/sandbox';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-panel-judge-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * 沙箱把输入原样当输出还回去，于是「期望答案是输入的平方」这套数据就能跑出
 * AC / WA 两种情况，而不用真的编译一个程序。
 */
function echoSandbox(): Sandbox {
  const run = async (_cmd: unknown, stdin: Buffer): Promise<RunResult> => ({
    status: 'OK',
    exitCode: 0,
    signal: null,
    stdout: stdin,
    stderr: Buffer.alloc(0),
    wallMs: 5,
    cpuMs: null,
    peakMemKb: 1024,
    truncated: false,
  });
  return { run, runConnected: () => Promise.reject(new Error('这些用例不走交互路径')) };
}

function makePackage(): string {
  const dir = path.join(workDir, 'pkg');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, PROBLEM_FILE),
    `${JSON.stringify(
      {
        id: 'A',
        name: 'A',
        type: 'traditional',
        limits: { ...DEFAULT_LIMITS },
        comparator: { mode: 'default' },
        subtasks: [
          { id: '1', points: 50, tests: ['1', '2'], dependsOn: [], scoring: 'min' },
          { id: '2', points: 50, tests: ['3'], dependsOn: ['1'], scoring: 'min' },
        ],
        tests: [
          { id: '1', input: 'data/1.in', answer: 'data/1.out', points: 25, subtask: '1' },
          { id: '2', input: 'data/2.in', answer: 'data/2.out', points: 25, subtask: '1' },
          { id: '3', input: 'data/3.in', answer: 'data/3.out', points: 50, subtask: '2' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  for (const id of ['1', '2', '3']) {
    fs.writeFileSync(path.join(dir, 'data', `${id}.in`), `${id}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'data', `${id}.out`), `${id}\n`, 'utf8');
  }
  return dir;
}

const toolchain = {
  kind: 'g++' as const,
  path: '/fake/g++',
  command: 'fake-g++',
  version: '',
};

describe('judgeProblem：只跑部分测试点（面板上单点运行）', () => {
  it('未归组文件数据判 AC 时，单点记录和题目总分都必须是 0', async () => {
    const dir = path.join(workDir, 'orphan-file-case');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, PROBLEM_FILE),
      `${JSON.stringify(
        {
          id: 'orphan-score',
          name: 'orphan-score',
          type: 'traditional',
          limits: { ...DEFAULT_LIMITS },
          comparator: { mode: 'default' },
          subtasks: [
            { id: '1', points: 30, tests: [], dependsOn: [], scoring: 'min' },
            { id: '2', points: 70, tests: ['2'], dependsOn: [], scoring: 'min' },
          ],
          tests: [
            { id: '1', input: 'data/1.in', answer: 'data/1.out', points: 30 },
            { id: '2', input: 'data/2.in', answer: 'data/2.out', points: 70, subtask: '2' },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'data', '1.in'), '1\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'data', '1.out'), '1\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'data', '2.in'), '2\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'data', '2.out'), '2\n', 'utf8');
    const pkg = await loadProblem(dir);

    const result = await judgeProblem(pkg, {
      runCmd: { cmd: '/fake/a.out', args: [] },
      toolchain,
      sandbox: echoSandbox(),
      cacheDir: workDir,
      onlyTestIds: ['1'],
    });

    expect(result.cases[0]?.verdict).toBe('AC');
    expect(result.cases[0]?.score).toBe(0);
    expect(result.score).toBe(0);
    expect(result.maxScore).toBe(70);
  });

  it('默认 0 分内联样例判错时，所在子任务不得自动满分', async () => {
    const dir = path.join(workDir, 'inline-zero-sample');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, PROBLEM_FILE),
      `${JSON.stringify(
        {
          id: 'sample-score',
          name: 'sample-score',
          type: 'traditional',
          limits: { ...DEFAULT_LIMITS },
          comparator: { mode: 'default' },
          subtasks: [
            {
              id: '1',
              points: 100,
              tests: ['sample-1'],
              dependsOn: [],
              scoring: 'min',
            },
          ],
          tests: [
            { id: 'sample-1', inputText: '1\n', answerText: '2\n', points: 0, subtask: '1' },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const pkg = await loadProblem(dir);

    const result = await judgeProblem(pkg, {
      runCmd: { cmd: '/fake/a.out', args: [] },
      toolchain,
      sandbox: echoSandbox(),
      cacheDir: workDir,
    });

    expect(result.cases[0]?.verdict).toBe('WA');
    expect(result.score).toBe(0);
    expect(result.maxScore).toBe(100);
    expect(result.subtasks[0]).toEqual({ id: '1', score: 0, maxScore: 100, status: 'none' });
  });

  it('只跑指定的点，并把结果标成 partial', async () => {
    const pkg = await loadProblem(makePackage());

    const result = await judgeProblem(pkg, {
      runCmd: { cmd: '/fake/a.out', args: [] },
      toolchain,
      sandbox: echoSandbox(),
      cacheDir: workDir,
      onlyTestIds: ['2'],
    });

    expect(result.cases.map((item) => item.test)).toEqual(['2']);
    expect(result.cases[0]?.verdict).toBe('AC');
    // 分数只按跑过的那部分算，所以必须标 partial，不能当成整题结论展示。
    expect(result.partial).toBe(true);
    expect(result.maxScore).toBe(100);
    // 顺带说明 partial 为什么非有不可：只跑一个点时，子任务 1 的组内 min 看到的是
    // 「点 1 没跑」，于是它和依赖它的子任务 2 都拿 0 分。这个 0 分不是选手的真实水平，
    // 谁把它当结论展示，谁就在骗人。
    expect(result.score).toBe(0);
    expect(result.subtasks.map((item) => item.status)).toEqual(['none', 'skipped']);
  });

  it('不给 onlyTestIds 时跑全部，且不标 partial', async () => {
    const pkg = await loadProblem(makePackage());

    const result = await judgeProblem(pkg, {
      runCmd: { cmd: '/fake/a.out', args: [] },
      toolchain,
      sandbox: echoSandbox(),
      cacheDir: workDir,
    });

    expect(result.cases.map((item) => item.test)).toEqual(['1', '2', '3']);
    expect(result.partial).toBeUndefined();
    expect(result.score).toBe(100);
    expect(result.subtasks.map((item) => item.status)).toEqual(['full', 'full']);
  });

  it('单点运行不影响别的点：改坏一个点只让它自己 WA', async () => {
    const pkg = await loadProblem(makePackage());
    // 把 2 的答案改成对不上的内容，再用只跑 2 的方式判它。
    fs.writeFileSync(path.join(pkg.rootDir, 'data', '2.out'), 'not-2\n', 'utf8');
    const reloaded = await loadProblem(pkg.rootDir);

    const result = await judgeProblem(reloaded, {
      runCmd: { cmd: '/fake/a.out', args: [] },
      toolchain,
      sandbox: echoSandbox(),
      cacheDir: workDir,
      onlyTestIds: ['2'],
    });

    expect(result.cases[0]?.verdict).toBe('WA');
    expect(result.subtasks.find((item) => item.id === '1')?.status).toBe('none');
  });
});
