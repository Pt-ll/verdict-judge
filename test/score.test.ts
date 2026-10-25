import { describe, expect, it } from 'vitest';
import { scoreProblem } from '../src/core/judge/score';
import {
  DEFAULT_LIMITS,
  type CaseResult,
  type Problem,
  type Subtask,
  type TestCase,
  type Verdict,
} from '../src/core/model';

function caseOf(test: string, score: number, max: number): CaseResult {
  const verdict: Verdict = score >= max ? 'AC' : 'WA';
  return {
    test,
    verdict,
    score,
    timeMs: 1,
    memoryKb: 1,
    exitCode: 0,
    signal: null,
    output: Buffer.alloc(0),
    answer: Buffer.alloc(0),
  };
}

function testOf(id: string, points: number): TestCase {
  return { id, input: `data/${id}.in`, answer: `data/${id}.out`, points };
}

function problemOf(subtasks: Subtask[], tests: TestCase[]): Problem {
  return {
    id: 'A',
    name: 'A',
    type: 'traditional',
    limits: { ...DEFAULT_LIMITS },
    comparator: { mode: 'default' },
    subtasks,
    tests,
  };
}

describe('scoreProblem', () => {
  it('没有子任务时就是各测试点之和（M1 的计分方式）', () => {
    const problem = problemOf([], [testOf('1', 1), testOf('2', 1)]);

    const result = scoreProblem(problem, [caseOf('1', 1, 1), caseOf('2', 0, 1)]);

    expect(result.score).toBe(1);
    expect(result.maxScore).toBe(2);
    expect(result.subtasks).toEqual([]);
  });

  it('min 计分：组内有一个点没满分，整个子任务就是 0 分', () => {
    const problem = problemOf(
      [{ id: '1', points: 30, tests: ['1', '2'], dependsOn: [], scoring: 'min' }],
      [testOf('1', 10), testOf('2', 20)],
    );

    const result = scoreProblem(problem, [caseOf('1', 10, 10), caseOf('2', 0, 20)]);

    expect(result.subtasks[0]).toEqual({ id: '1', score: 0, maxScore: 30, status: 'none' });
    expect(result.score).toBe(0);
    expect(result.maxScore).toBe(30);
  });

  it('依赖未满分时，后继子任务 skipped 且计 0 分', () => {
    const problem = problemOf(
      [
        { id: '1', points: 30, tests: ['1'], dependsOn: [], scoring: 'min' },
        { id: '2', points: 70, tests: ['2'], dependsOn: ['1'], scoring: 'min' },
      ],
      [testOf('1', 30), testOf('2', 70)],
    );

    // 第 1 组只拿到一半分：partial 也会挡住依赖它的子任务，这正是 SPEC §12 M2 的验收点。
    const result = scoreProblem(problem, [caseOf('1', 15, 30), caseOf('2', 70, 70)]);

    expect(result.subtasks[0]).toEqual({ id: '1', score: 15, maxScore: 30, status: 'partial' });
    expect(result.subtasks[1]).toEqual({ id: '2', score: 0, maxScore: 70, status: 'skipped' });
    expect(result.score).toBe(15);
    expect(result.maxScore).toBe(100);
  });

  it('依赖满分后，后继子任务正常计分', () => {
    const problem = problemOf(
      [
        { id: '1', points: 30, tests: ['1'], dependsOn: [], scoring: 'min' },
        { id: '2', points: 70, tests: ['2'], dependsOn: ['1'], scoring: 'min' },
      ],
      [testOf('1', 30), testOf('2', 70)],
    );

    const result = scoreProblem(problem, [caseOf('1', 30, 30), caseOf('2', 35, 70)]);

    expect(result.subtasks[0]?.status).toBe('full');
    expect(result.subtasks[1]).toEqual({ id: '2', score: 35, maxScore: 70, status: 'partial' });
    expect(result.score).toBe(65);
  });


  it('内联样例按实际判定计分：跑了通过才拿分，没跑就是 0', () => {
    const sample = { id: 'sample-1', inputText: '1\n', answerText: '1\n', points: 10 };
    const problem = problemOf([], [sample, testOf('1', 90)]);

    // 还没跑样例：满分包含它的 10 分，但得分为 0（不默认送分）。
    const notRun = scoreProblem(problem, [caseOf('1', 90, 90)]);
    expect(notRun.score).toBe(90);
    expect(notRun.maxScore).toBe(100);

    // 样例跑挂了：同样拿 0 分。
    const failedSample = scoreProblem(problem, [caseOf('sample-1', 0, 10), caseOf('1', 90, 90)]);
    expect(failedSample.score).toBe(90);

    // 样例跑过了：拿满 10 分。
    const passedSample = scoreProblem(problem, [caseOf('sample-1', 10, 10), caseOf('1', 90, 90)]);
    expect(passedSample.score).toBe(100);
  });

  it('min 组里的内联样例与数据点一视同仁：样例挂在组里也会拉低整组', () => {
    const sample = { id: 'sample-1', inputText: '1\n', answerText: '1\n', points: 10 };
    const problem = problemOf(
      [{ id: '1', points: 100, tests: ['sample-1', '1'], dependsOn: [], scoring: 'min' }],
      [sample, testOf('1', 90)],
    );

    const result = scoreProblem(problem, [caseOf('sample-1', 0, 10), caseOf('1', 90, 90)]);

    expect(result.score).toBe(0);
    expect(result.subtasks[0]?.status).toBe('none');
  });

  it('空子任务记 0 分 / 0 满分，不撑大满分、也不产生 Infinity', () => {
    const problem = problemOf(
      [
        { id: '1', points: 30, tests: [], dependsOn: [], scoring: 'min' },
        { id: '2', points: 70, tests: ['1'], dependsOn: [], scoring: 'min' },
      ],
      [testOf('1', 70)],
    );

    const result = scoreProblem(problem, [caseOf('1', 70, 70)]);

    expect(result.score).toBe(70);
    expect(result.maxScore).toBe(70);
    expect(result.subtasks[0]).toMatchObject({ id: '1', score: 0, maxScore: 0, status: 'none' });
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('依赖空子任务的后继仍然被跳过', () => {
    const problem = problemOf(
      [
        { id: '1', points: 30, tests: [], dependsOn: [], scoring: 'min' },
        { id: '2', points: 70, tests: ['1'], dependsOn: ['1'], scoring: 'min' },
      ],
      [testOf('1', 70)],
    );

    const result = scoreProblem(problem, [caseOf('1', 70, 70)]);

    expect(result.subtasks[1]?.status).toBe('skipped');
    expect(result.score).toBe(0);
    expect(result.maxScore).toBe(70);
  });

  it('sum 计分：按各测试点的满分加权', () => {
    const problem = problemOf(
      [{ id: '1', points: 30, tests: ['1', '2'], dependsOn: [], scoring: 'sum' }],
      [testOf('1', 10), testOf('2', 20)],
    );

    // 10/10 与 5/20 -> (10 + 5) / 30 = 0.5 -> 15 分
    const result = scoreProblem(problem, [caseOf('1', 10, 10), caseOf('2', 5, 20)]);

    expect(result.subtasks[0]?.score).toBe(15);
    expect(result.subtasks[0]?.status).toBe('partial');
  });

  it('不属于任何子任务的测试点直接计入总分，不会凭空消失', () => {
    const problem = problemOf(
      [{ id: '1', points: 30, tests: ['1'], dependsOn: [], scoring: 'min' }],
      [testOf('1', 10), testOf('9', 20)],
    );

    const result = scoreProblem(problem, [caseOf('1', 10, 10), caseOf('9', 20, 20)]);

    expect(result.score).toBe(50);
    expect(result.maxScore).toBe(50);
  });

  it('没有结果的测试点按 0 分算（取消或中途失败）', () => {
    const problem = problemOf(
      [{ id: '1', points: 30, tests: ['1', '2'], dependsOn: [], scoring: 'min' }],
      [testOf('1', 10), testOf('2', 20)],
    );

    const result = scoreProblem(problem, [caseOf('1', 10, 10)]);

    expect(result.subtasks[0]?.score).toBe(0);
    expect(result.subtasks[0]?.status).toBe('none');
  });

  it('子任务结果的顺序跟着声明顺序，方便直接显示', () => {
    const problem = problemOf(
      [
        { id: '2', points: 70, tests: ['2'], dependsOn: ['1'], scoring: 'min' },
        { id: '1', points: 30, tests: ['1'], dependsOn: [], scoring: 'min' },
      ],
      [testOf('1', 30), testOf('2', 70)],
    );

    const result = scoreProblem(problem, [caseOf('1', 30, 30), caseOf('2', 70, 70)]);

    expect(result.subtasks.map((item) => item.id)).toEqual(['2', '1']);
    expect(result.score).toBe(100);
  });
});
