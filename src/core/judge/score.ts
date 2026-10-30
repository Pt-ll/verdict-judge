import type { CaseResult, Problem, SubtaskResult } from '../model';
import { topoOrderSubtasks } from '../problem/subtasks';

export interface ProblemScore {
  /** 按声明顺序返回，方便直接显示；计算顺序另有拓扑序。 */
  subtasks: SubtaskResult[];
  score: number;
  maxScore: number;
}

/**
 * 子任务计分（SPEC §5.5）。
 *
 * 逐个子任务算：
 *   依赖的子任务不是 full -> 本子任务 skipped，计 0 分（这就是「依赖未满分则不进入」）；
 *   scoring='min' -> 组内得分率的最小值；'sum' -> 按各测试点满分加权求和。
 * 题目定义了子任务后，未归入任何子任务的测试点只提供判定反馈，默认按 0 分处理；
 * 没有子任务时仍是各测试点之和，也就是 M1 与普通平铺题目的计分方式。
 */
export function scoreProblem(problem: Problem, cases: CaseResult[]): ProblemScore {
  const caseById = new Map(cases.map((item) => [item.test, item]));
  const testById = new Map(problem.tests.map((test) => [test.id, test]));

  /** 测试点满分；没写 points 的按 1 分计（M1 的约定式数据就是这种）。 */
  const maxOf = (testId: string): number => testById.get(testId)?.points ?? 1;

  const ratioOf = (testId: string): number => {
    const max = maxOf(testId);
    const result = caseById.get(testId);
    if (max <= 0) {
      // 0 分测试点本身不增加总分，但一旦被放进子任务，就仍然必须按实际判定参与组内计分。
      // 否则默认 0 分的内联样例会被无条件视为通过，单独放进一个子任务时甚至直接送满分。
      // 这类点没有可用的 score / max 比例，因此只有 AC 记为通过，其余判定与未运行都记 0。
      return result?.verdict === 'AC' ? 1 : 0;
    }
    // 内联样例与数据点走完全相同的规则：按实际判定算分。
    // 它是「样例」不代表它默认通过——没跑、没通过都是 0 分（§5.5）。
    if (result === undefined) {
      // 取消或中途失败时某些点没有结果，按 0 分算，而不是装作没这个点。
      return 0;
    }
    return Math.min(1, Math.max(0, result.score / max));
  };

  const ordered = topoOrderSubtasks(problem.subtasks);
  const computed = new Map<string, SubtaskResult>();

  for (const subtask of ordered) {
    if (subtask.tests.length === 0) {
      // 空子任务（刚建出来、或把最后一个测试点移走了）：还没有可判的东西。
      // 记 0 分 / 0 满分 —— 既不能白送 points，也不能先把整题满分撑大。
      computed.set(subtask.id, {
        id: subtask.id,
        score: 0,
        maxScore: 0,
        status: 'none',
      });
      continue;
    }

    const blocked = subtask.dependsOn.some((id) => computed.get(id)?.status !== 'full');
    if (blocked) {
      computed.set(subtask.id, {
        id: subtask.id,
        score: 0,
        maxScore: subtask.points,
        status: 'skipped',
      });
      continue;
    }

    const ratio =
      subtask.scoring === 'min'
        ? Math.min(...subtask.tests.map(ratioOf))
        : weightedRatio(subtask.tests, ratioOf, maxOf);

    computed.set(subtask.id, {
      id: subtask.id,
      score: Math.round(subtask.points * ratio),
      maxScore: subtask.points,
      // 用得分率判断是否满分：points 取整后恰好等于满分，不代表真的全对。
      status: ratio >= 1 ? 'full' : ratio > 0 ? 'partial' : 'none',
    });
  }

  let score = 0;
  let maxScore = 0;

  for (const subtask of problem.subtasks) {
    const result = computed.get(subtask.id);
    if (result !== undefined) {
      score += result.score;
      maxScore += result.maxScore;
    }
  }
  if (problem.subtasks.length === 0) {
    for (const test of problem.tests) {
      score += caseById.get(test.id)?.score ?? 0;
      maxScore += maxOf(test.id);
    }
  }

  return {
    subtasks: problem.subtasks.map(
      (subtask) =>
        computed.get(subtask.id) ?? {
          id: subtask.id,
          score: 0,
          maxScore: subtask.points,
          status: 'none',
        },
    ),
    score,
    maxScore,
  };
}

function weightedRatio(
  tests: string[],
  ratioOf: (testId: string) => number,
  maxOf: (testId: string) => number,
): number {
  let earned = 0;
  let total = 0;
  for (const testId of tests) {
    const max = maxOf(testId);
    total += max;
    earned += max * ratioOf(testId);
  }
  if (total > 0) {
    return earned / total;
  }
  // 全是 0 分点时没有权重可用，退回等权平均。不能直接按满分算：那会让没跑或判错的
  // 默认 0 分样例自动拿到整个子任务的分值。空子任务已在调用处单独处理，这里 tests 非空。
  return tests.reduce((sum, testId) => sum + ratioOf(testId), 0) / tests.length;
}
