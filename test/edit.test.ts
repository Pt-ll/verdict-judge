import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type Problem, type Subtask, type TestCase } from '../src/core/model';
import {
  addSubtask,
  clearSubtasks,
  evenSubtasks,
  nextSubtaskId,
  planAddTests,
  removeSubtask,
  removeTest,
  setTestSubtask,
  updateSubtask,
  validateLimits,
  withComparator,
  withLimits,
} from '../src/core/problem/edit';
import { PROBLEM_FILE, loadProblem, saveProblem } from '../src/core/problem/package';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-edit-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

function makePackage(files: Record<string, string>): string {
  const dir = path.join(workDir, `pkg-${counter++}`);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

function testOf(id: string, points = 1): TestCase {
  return { id, input: `data/${id}.in`, answer: `data/${id}.out`, points };
}

function problemOf(tests: TestCase[]): Problem {
  return {
    id: 'A',
    name: 'A',
    type: 'traditional',
    limits: { ...DEFAULT_LIMITS },
    comparator: { mode: 'default' },
    subtasks: [],
    tests,
  };
}

function withSubtasks(problem: Problem, subtasks: Subtask[]): Problem {
  // 测试点上的 subtask 字段要跟着子任务走，否则加载期会因「两边不一致」报错。
  const owner = new Map(
    subtasks.flatMap((subtask) => subtask.tests.map((testId) => [testId, subtask.id] as const)),
  );
  return {
    ...problem,
    subtasks,
    tests: problem.tests.map((test) => {
      const id = owner.get(test.id);
      return id === undefined ? test : { ...test, subtask: id };
    }),
  };
}

describe('planAddTests', () => {
  it('只挑没登记过的数据，已登记的原样跳过', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: JSON.stringify({
        id: 'A',
        tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
      }),
      'data/1.in': '1\n',
      'data/1.out': '1\n',
      'data/2.in': '2\n',
      'data/2.out': '2\n',
      'data/3.in': '3\n',
      'data/3.ans': '3\n',
    });

    const plan = await planAddTests(await loadProblem(dir));

    expect(plan.added.map((test) => test.id)).toEqual(['2', '3']);
    // 路径相对数据目录（0.1.3 起）；旧写法 data/1.in 在加载时已经归一过，所以这里不会重复登记。
    expect(plan.added.map((test) => test.input)).toEqual(['2.in', '3.in']);
    // .ans 也是合法答案后缀，登记时按实际文件名写进去。
    expect(plan.added[1]?.answer).toBe('3.ans');
    expect(plan.skipped).toEqual(['1']);
  });

  it('id 撞车但文件不同的数据也算已登记，避免写出重复 id 的 problem.json', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: JSON.stringify({
        id: 'A',
        tests: [{ id: 'sample', input: 'data/other.in', answer: 'data/other.out' }],
      }),
      'data/sample.in': '1\n',
      'data/sample.out': '1\n',
    });

    const plan = await planAddTests(await loadProblem(dir));

    expect(plan.added).toEqual([]);
    expect(plan.skipped).toEqual(['sample']);
  });
});

describe('evenSubtasks', () => {
  it('按顺序均分，余数给前面的组', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2'), testOf('3'), testOf('4'), testOf('5')], 2);

    expect(plan.subtasks.map((item) => item.tests)).toEqual([['1', '2', '3'], ['4', '5']]);
    expect(plan.subtasks.map((item) => item.points)).toEqual([50, 50]);
    // 组间独立：OI 的分档通常是各自独立计分，依赖要人去显式加。
    expect(plan.subtasks.map((item) => item.dependsOn)).toEqual([[], []]);
    expect(plan.subtasks.map((item) => item.scoring)).toEqual(['min', 'min']);
  });

  it('总分除不尽时余数给前面的组', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2'), testOf('3')], 3, 100);

    expect(plan.subtasks.map((item) => item.points)).toEqual([34, 33, 33]);
  });

  it('组数超过测试点数时按测试点数分组', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2')], 5);

    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks.map((item) => item.tests)).toEqual([['1'], ['2']]);
  });

  it('同步更新测试点上的 subtask 字段（两边必须一致，否则加载会报错）', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2')], 2);

    expect(plan.tests.map((test) => test.subtask)).toEqual(['1', '2']);
  });

  it('没有测试点时返回空计划', () => {
    expect(evenSubtasks([], 3)).toEqual({ subtasks: [], tests: [] });
  });
});

describe('clearSubtasks', () => {
  it('去掉 subtask 字段，其他字段不动', () => {
    const tests: TestCase[] = [
      { ...testOf('1'), subtask: '1' },
      testOf('2'),
    ];

    const cleared = clearSubtasks(tests);

    expect(cleared[0]?.subtask).toBeUndefined();
    expect(cleared[0]?.input).toBe('data/1.in');
    expect(cleared[1]?.subtask).toBeUndefined();
  });
});

describe('withLimits', () => {
  it('只改给定的字段', () => {
    const problem = problemOf([]);

    const updated = withLimits(problem, { timeMs: 2000, memoryMb: 512 });

    expect(updated.limits.timeMs).toBe(2000);
    expect(updated.limits.memoryMb).toBe(512);
    expect(updated.limits.outputKb).toBe(DEFAULT_LIMITS.outputKb);
    // 原对象不被改动：调用方可能还握着它做别的事。
    expect(problem.limits.timeMs).toBe(DEFAULT_LIMITS.timeMs);
  });

  it('非法值直接忽略，不会把 undefined 或 NaN 写进 problem.json', () => {
    const updated = withLimits(problemOf([]), {
      timeMs: Number.NaN,
      outputKb: undefined,
    });

    expect(updated.limits.timeMs).toBe(DEFAULT_LIMITS.timeMs);
    expect(updated.limits.outputKb).toBe(DEFAULT_LIMITS.outputKb);
  });
});

describe('编辑后能重新读回来', () => {
  it('均分子任务 -> 保存 -> 加载，不报错且内容正确', async () => {
    const dir = makePackage({
      // 显式登记了 1：这样 2 才是「新数据」，两个命令的真实顺序也才跑得通。
      // （若完全不写 tests，加载时就会自动扫描 data/，那 addTests 就没有活可干了。）
      [PROBLEM_FILE]: JSON.stringify({
        id: 'A',
        tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
      }),
      'data/1.in': '1\n',
      'data/1.out': '1\n',
      'data/2.in': '2\n',
      'data/2.out': '2\n',
    });
    const pkg = await loadProblem(dir);

    // 先把数据登记进来，再分组——这正是两个命令的真实使用顺序。
    pkg.problem.tests = (await planAddTests(pkg)).tests;
    const grouped = evenSubtasks(pkg.problem.tests, 2);
    pkg.problem.subtasks = grouped.subtasks;
    pkg.problem.tests = grouped.tests;
    await saveProblem(pkg);

    const reloaded = await loadProblem(dir);

    expect(reloaded.problem.tests.map((test) => test.id)).toEqual(['1', '2']);
    expect(reloaded.problem.subtasks.map((item) => item.tests)).toEqual([['1'], ['2']]);
    expect(reloaded.problem.subtasks.map((item) => item.points)).toEqual([50, 50]);
  });

  /**
   * 面板上的每次编辑都会立刻落盘，所以「改完还读得回来」是硬要求：
   * loadProblem 会校验成员关系一致、依赖不成环、子任务不为空——只要有一条不满足，
   * 用户下次打开题目包就会看到加载失败，那比不让改还糟。
   */
  it('面板的编辑（加子任务 / 移归属 / 删子任务 / 移出测试点）都能重新读回来', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: JSON.stringify({
        id: 'A',
        tests: [
          { id: '1', input: 'data/1.in', answer: 'data/1.out' },
          { id: '2', input: 'data/2.in', answer: 'data/2.out' },
          { id: '3', input: 'data/3.in', answer: 'data/3.out' },
        ],
      }),
      'data/1.in': '1\n',
      'data/1.out': '1\n',
      'data/2.in': '2\n',
      'data/2.out': '2\n',
      'data/3.in': '3\n',
      'data/3.out': '3\n',
    });
    const pkg = await loadProblem(dir);

    let problem = addSubtask(pkg.problem, 30);
    expect(problem.subtasks.map((item) => item.id)).toEqual(['1']);
    expect(problem.subtasks[0]?.tests).toEqual(['1']);

    problem = addSubtask(problem, 70);
    problem = setTestSubtask(problem, '3', '2');
    problem = updateSubtask(problem, '2', { points: 60, scoring: 'sum', dependsOn: ['1'] });
    problem = removeTest(problem, '2');
    await saveProblem({ ...pkg, problem });

    const reloaded = await loadProblem(dir);
    expect(reloaded.problem.tests.map((test) => test.id)).toEqual(['1', '3']);
    expect(reloaded.problem.subtasks.map((item) => item.id)).toEqual(['1', '2']);
    expect(reloaded.problem.subtasks[1]?.tests).toEqual(['3']);
    expect(reloaded.problem.subtasks[1]?.dependsOn).toEqual(['1']);
    expect(reloaded.problem.subtasks[1]?.scoring).toBe('sum');
    expect(reloaded.problem.subtasks[1]?.points).toBe(60);

    // 删掉被依赖的那个子任务：依赖要跟着摘掉，否则下一次加载会因为
    // 「依赖了不存在的子任务」直接报错。
    await saveProblem({ ...pkg, problem: removeSubtask(reloaded.problem, '1') });
    const again = await loadProblem(dir);
    expect(again.problem.subtasks.map((item) => item.id)).toEqual(['2']);
    expect(again.problem.subtasks[0]?.dependsOn).toEqual([]);
    // 它名下的测试点保留，只是不再属于任何子任务。
    expect(again.problem.tests.map((test) => test.subtask ?? null)).toEqual([null, '2']);
  });
});

describe('子任务与测试点的编辑规则', () => {
  it('id 取「最大已用编号 + 1」，删掉中间一个也不会撞车', () => {
    const problem = withSubtasks(problemOf([testOf('1')]), [
      { id: '1', points: 10, tests: ['1'], dependsOn: [], scoring: 'min' },
      { id: '3', points: 10, tests: [], dependsOn: [], scoring: 'min' },
    ]);
    expect(nextSubtaskId(problem)).toBe('4');
  });

  it('新建子任务会先认领一个还没归属的测试点（空子任务是非法的）', () => {
    const problem = withSubtasks(problemOf([testOf('1'), testOf('2')]), [
      { id: '1', points: 10, tests: ['1'], dependsOn: [], scoring: 'min' },
    ]);
    const next = addSubtask(problem, 20);
    expect(next.subtasks[1]?.tests).toEqual(['2']);
    expect(next.tests.find((test) => test.id === '2')?.subtask).toBe('2');
  });

  it('没有测试点时不让加子任务', () => {
    expect(() => addSubtask(problemOf([]), 10)).toThrow(/还没有测试点/);
  });

  it('依赖成环、依赖自己、依赖不存在的子任务都会被挡下', () => {
    const problem = withSubtasks(problemOf([testOf('1'), testOf('2')]), [
      { id: '1', points: 50, tests: ['1'], dependsOn: [], scoring: 'min' },
      { id: '2', points: 50, tests: ['2'], dependsOn: [], scoring: 'min' },
    ]);
    expect(() => updateSubtask(problem, '1', { dependsOn: ['1'] })).toThrow(/不能依赖自己/);
    expect(() => updateSubtask(problem, '1', { dependsOn: ['9'] })).toThrow(/不存在/);

    const chained = updateSubtask(problem, '2', { dependsOn: ['1'] });
    expect(() => updateSubtask(chained, '1', { dependsOn: ['2'] })).toThrow(/成环/);
  });

  it('移出没有登记的测试点会报错，而不是悄悄什么都不做', () => {
    expect(() => removeTest(problemOf([testOf('1')]), '9')).toThrow(/找不到测试点/);
  });

  it('限制的校验说清是哪一项不合法', () => {
    expect(validateLimits({ timeMs: 0 })).toMatch(/时间限制/);
    expect(validateLimits({ memoryMb: -1 })).toMatch(/内存限制/);
    expect(validateLimits({ outputKb: 0 })).toBeNull();
    expect(validateLimits({ timeMs: 1000.5 })).toMatch(/整数/);
  });

  it('换比较方式时带上新配置，不残留旧的 spj 路径', () => {
    const problem: Problem = {
      ...problemOf([testOf('1')]),
      comparator: { mode: 'spj', spj: 'extra/checker.cpp' },
    };
    const switched = withComparator(problem, { mode: 'real', absEps: 1e-9, relEps: 1e-9 });
    expect(switched.comparator).toEqual({ mode: 'real', absEps: 1e-9, relEps: 1e-9 });
  });
});
