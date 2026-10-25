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
 * 不属于任何子任务的测试点直接计入总分，避免「加了子任务之后某些点凭空消失」。
 * 没有子任务时就是各测试点之和，也就是 M1 的计分方式。
 */
export function scoreProblem(problem: Problem, cases: CaseResult[]): ProblemScore {
  const caseById = new Map(cases.map((item) => [item.test, item]));
  const testById = new Map(problem.tests.map((test) => [test.id, test]));

  /** 测试点满分；没写 points 的按 1 分计（M1 的约定式数据就是这种）。 */
  const maxOf = (testId: string): number => testById.get(testId)?.points ?? 1;

  const ratioOf = (testId: string): number => {
    const max = maxOf(testId);
    if (max <= 0) {
      // 满分是 0 的测试点没有分可丢，不参与拉低组内得分率。
      return 1;
    }
    // 内联样例与数据点走完全相同的规则：按实际判定算分。
    // 它是「样例」不代表它默认通过——没跑、没通过都是 0 分（§5.5）。
    const result = caseById.get(testId);
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

  const claimed = new Set(problem.subtasks.flatMap((subtask) => subtask.tests));
  let score = 0;
  let maxScore = 0;

  for (const subtask of problem.subtasks) {
    const result = computed.get(subtask.id);
    if (result !== undefined) {
      score += result.score;
      maxScore += result.maxScore;
    }
  }
  for (const test of problem.tests) {
    if (claimed.has(test.id)) {
      continue;
    }
    score += caseById.get(test.id)?.score ?? 0;
    maxScore += maxOf(test.id);
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
  // 组内全是 0 分测试点时无从谈得分率，按满分算，否则它会凭空拖垮总分。
  return total <= 0 ? 1 : earned / total;
}
