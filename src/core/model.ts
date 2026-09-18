/**
 * 数据模型。
 *
 * M1 只落地当前用得到的部分；Problem / Contest / Submission 等在对应里程碑落地时再补，
 * 避免先写一堆没人用的空结构。
 */

export type ProblemType = 'traditional' | 'interactive';

export type Verdict =
  | 'AC'
  | 'WA'
  | 'TLE'
  | 'MLE'
  | 'OLE'
  | 'RE'
  | 'CE'
  | 'PC'
  | 'UKE';

export interface Limits {
  timeMs: number;
  memoryMb: number;
  stackMb: number;
  outputKb: number;
}

/** 与 SPEC §7.2 的默认值保持一致。 */
export const DEFAULT_LIMITS: Limits = {
  timeMs: 1000,
  memoryMb: 256,
  stackMb: 256,
  outputKb: 4096,
};

/** 单次进程执行的结果分类，见 SPEC §5.3 / §8.5。 */
export type RunVerdict = 'OK' | 'TLE' | 'MLE' | 'OLE' | 'RE' | 'INTERNAL';

export type ComparatorMode = 'default' | 'line' | 'real' | 'spj' | 'interactive';

export interface TestCase {
  id: string;
  /**
   * 输入文件路径。
   *
   * 题目包里相对**数据目录**（SPEC §6.3，通常写作 "1.in"；0.1.2 及更早的
   * "data/1.in" 加载时会被归一成同一个意思，见 problem/package.ts 的 normalizeTestPath）；
   * M1 的约定式查找（findTestsBesideSource）里则相对数据目录。
   */
  input: string;
  /** 答案文件路径，基准同 input。 */
  answer: string;
  /** 该测试点分值；未写时按 1 分计（见 judge/score.ts）。 */
  points?: number;
  /**
   * 该测试点属于哪个子任务。
   *
   * 成员关系的权威来源是 Subtask.tests；这个字段是给人看的提示，
   * 两者不一致时 problem/package.ts 会报错，而不是悄悄按其中一个算分。
   */
  subtask?: string;
  /** 可选的数据合法性校验器（M4 落地）。 */
  validator?: string;
}

/** 子任务：OI 赛制的分组计分，见 SPEC §5.5。 */
export interface Subtask {
  id: string;
  name?: string;
  points: number;
  /** 归属该子任务的测试点 id 列表。 */
  tests: string[];
  /** 依赖的子任务 id：依赖未满分时本子任务被 skip 且计 0 分。 */
  dependsOn: string[];
  /** 子任务内计分方式：min 取各测试点得分率的最小值，sum 按得分率求和。 */
  scoring: 'min' | 'sum';
}

export interface Problem {
  id: string;
  name: string;
  type: ProblemType;
  limits: Limits;
  comparator: ComparatorConfig;
  subtasks: Subtask[];
  tests: TestCase[];
  /**
   * 选手源码目录与标准程序目录（支持 glob，M3 的比赛模式才真正用到）。
   * 题目包里可以不写：缺省表示源码就在题目包附近。
   */
  sourceDir?: string;
  answerDir?: string;
  /** 原始 problem.json 里的未知字段，写回时原样保留（SPEC §6.5）。 */
  _raw?: Record<string, unknown>;
}

/** 比较方式配置，见 SPEC §6.4 的几种写法。 */
export interface ComparatorConfig {
  mode: ComparatorMode;
  /** real 模式的绝对误差。 */
  absEps?: number;
  /** real 模式的相对误差。 */
  relEps?: number;
  /** spj 源码或可执行文件路径。 */
  spj?: string;
  /** 交互题交互器。 */
  interactor?: string;
}

/**
 * 与 vscode.CancellationToken 结构兼容的最小接口。
 *
 * core 层禁止 import vscode，所以这里声明一个结构等价的类型：
 * UI 层可以直接把 vscode 的 token 传进来，core 不需要知道它的来源。
 */
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** 单个测试点的判定结果，见 SPEC §5.5。 */
export interface CaseResult {
  test: string;
  verdict: Verdict;
  score: number;
  timeMs: number;
  memoryKb: number;
  exitCode: number | null;
  signal: string | null;
  message?: string;
  /** 实际输出与标准答案，供 diff 与报告使用。 */
  output: Buffer;
  answer: Buffer;
  firstDiffLine?: number;
}

export interface SubtaskResult {
  id: string;
  score: number;
  maxScore: number;
  status: 'full' | 'partial' | 'none' | 'skipped';
}

export interface ProblemResult {
  problem: string;
  score: number;
  maxScore: number;
  cases: CaseResult[];
  subtasks: SubtaskResult[];
  elapsedMs: number;
  /**
   * 只跑了一部分测试点。
   *
   * 面板上单点「运行」就是这样：分数只按跑过的那部分算，是个下界而不是结论，
   * 所以调用方必须显式区分，不能把它当成整题的得分展示。
   */
  partial?: boolean;
}

export interface Contestant {
  id: string;
  name: string;
  /** 选手目录，相对工作区根目录，例如 "players/alice"。 */
  folder: string;
}

export interface Contest {
  id: string;
  title: string;
  /** contest.json 里只写题目 id，这里放展开后的题目包（SPEC §5.1）。 */
  problems: Problem[];
  contestants: Contestant[];
  /** 允许的重测次数上限，超过就不许再重测（SPEC §5.7）。 */
  maxRejudge: number;
  /** 原始 contest.json 里的未知字段，写回时保留。 */
  _raw?: Record<string, unknown>;
}

export interface Submission {
  id: string;
  contestant: string;
  problem: string;
  /** 选手源码的绝对路径。 */
  source: string;
  language: string;
  result?: ProblemResult;
  /**
   * 该次提交的整体判定。
   *
   * 正常评测时它等于 result.cases 里最严重的那一个（同一处算出来，不会打架）；
   * 编译失败这种「一个测试点都没跑」的情况 result.cases 是空的，只有它才有话说。
   */
  verdict?: Verdict;
  /** 编译失败等整体性问题的说明。 */
  message?: string;
  rejudgeCount: number;
  /** ISO 时间戳。 */
  time: string;
}

export interface StandingsCell {
  contestant: string;
  problem: string;
  score: number;
  /** 没提交过就是 null。 */
  verdict: Verdict | null;
}

export interface Standings {
  cells: StandingsCell[];
  totals: { contestant: string; score: number }[];
  /** rank 是并列名次（同分同名次，跳号：1、2、2、4）。 */
  ranks: { contestant: string; rank: number; score: number }[];
}

export interface ContestStats {
  /** 各选手总分，按分数降序。 */
  scores: { contestant: string; score: number }[];
  average: number;
  highest: number;
  lowest: number;
  problems: {
    problem: string;
    /** 拿到满分的选手数。 */
    accepted: number;
    /** 有提交的选手数。 */
    attempted: number;
    averageScore: number;
  }[];
  /** 每个测试点的时间与内存，供散点图使用（SPEC §4.7）。 */
  cases: {
    contestant: string;
    problem: string;
    test: string;
    timeMs: number;
    memoryKb: number;
    verdict: Verdict;
  }[];
}

/**
 * 判定严重程度：越靠前越严重。
 *
 * 用于「一组测试点的总体判定」这类汇总（榜单单元格、状态栏、HTML 报告），
 * 只放一处，免得各处排序不一致、同一次评测在不同地方显示成不同的结论。
 */
export const VERDICT_PRIORITY: Verdict[] = [
  'UKE',
  'RE',
  'MLE',
  'OLE',
  'TLE',
  'WA',
  'PC',
  'CE',
  'AC',
];

/** 取一组测试点里最严重的那一个判定；空数组返回 null。 */
export function summarizeVerdict(cases: CaseResult[]): Verdict | null {
  for (const verdict of VERDICT_PRIORITY) {
    if (cases.some((item) => item.verdict === verdict)) {
      return verdict;
    }
  }
  return null;
}

/**
 * checker / interactor 的运行限制：它们是评测方，给得比选手宽松。
 *
 * 它们是出题人写的、要在一次运行里处理整个测试点，卡在和选手一样的限额上会把
 * 正常的 checker 误判成失败——而这个失败会以 UKE 的形式报出来，让人以为是环境坏了。
 */
export function checkerLimits(limits: Limits): Limits {
  return {
    ...limits,
    timeMs: Math.max(1000, limits.timeMs * 10),
    memoryMb: Math.max(1024, limits.memoryMb * 2),
  };
}
