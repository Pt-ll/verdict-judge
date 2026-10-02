import { createComparator, type Comparator } from '../compare/compare';
import { prepareComparator } from '../compare/prepare';
import type { Toolchain } from '../compiler';
import type {
  CancellationTokenLike,
  CaseResult,
  ComparatorConfig,
  Limits,
  ProblemResult,
  RunVerdict,
  Verdict,
} from '../model';
import { readTestData, type ProblemPackage } from '../problem/package';
import type { RunCommand, RunResult, Sandbox } from '../sandbox/sandbox';
import { scoreProblem } from './score';
import { checkerLimits } from '../model';
import type { InteractiveRunner } from '../compare/interactive';

// CaseResult 住在 model.ts（它是最基础的数据模型，score.ts 与 UI 都要用），
// 这里转出去是为了不打断已有的 `from '../core/judge/judge'` 导入。
export type { CaseResult };

export interface JudgeCaseInput {
  testId: string;
  input: Buffer;
  answer: Buffer;
  runCmd: RunCommand;
  /** 该测试点分值；缺省按 1 计，M2 引入子任务后会显式传入。 */
  points?: number;
}

export interface JudgeOptions {
  limits: Limits;
  comparator: ComparatorConfig;
  /**
   * 已经准备好的比较器（SPJ 要先编译 checker、交互题要先编译 interactor）。
   * 给了就用它，否则按 comparator 现造一个纯函数的。
   */
  prepared?: Comparator;
  /**
   * 交互题（SPEC §5.6）：由它自己起选手程序并和 interactor 对接。
   * 交互题的「输出」在对话里被消耗掉了，没法事后拿 Buffer 比较。
   */
  interactive?: InteractiveRunner;
}

/**
 * 单测试点判定。
 *
 * 流程严格按 SPEC §5.5：
 *   运行 -> 超时/内存/输出/退出码优先判定 -> 都正常才交给比较器。
 * 编译错误不在这里处理，它由编译阶段单独给出 CE。
 */
export class Judge {
  private readonly comparator: Comparator;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly options: JudgeOptions,
  ) {
    this.comparator = options.prepared ?? createComparator(options.comparator);
  }

  async judgeCase(
    test: JudgeCaseInput,
    token?: CancellationTokenLike,
  ): Promise<CaseResult> {
    if (this.options.interactive !== undefined) {
      return this.judgeInteractiveCase(test, token);
    }
    const run = await this.sandbox.run(
      test.runCmd,
      test.input,
      this.options.limits,
      token,
    );
    const points = test.points ?? 1;

    if (run.status !== 'OK') {
      return {
        test: test.testId,
        verdict: runStatusToVerdict(run.status),
        score: 0,
        timeMs: run.wallMs,
        memoryKb: run.peakMemKb,
        exitCode: run.exitCode,
        signal: run.signal,
        message: describeRunFailure(run),
        output: run.stdout,
        answer: test.answer,
      };
    }

    const compared = await this.comparator.compare({
      input: test.input,
      output: run.stdout,
      answer: test.answer,
    });

    return {
      test: test.testId,
      verdict: compared.verdict,
      score: points * compared.scoreRatio,
      timeMs: run.wallMs,
      memoryKb: run.peakMemKb,
      exitCode: run.exitCode,
      signal: run.signal,
      message: compared.detail,
      output: run.stdout,
      answer: test.answer,
      firstDiffLine: compared.firstDiffLine,
    };
  }

  private async judgeInteractiveCase(
    test: JudgeCaseInput,
    token?: CancellationTokenLike,
  ): Promise<CaseResult> {
    const interactive = this.options.interactive;
    if (interactive === undefined) {
      throw new Error('交互题路径需要 interactive');
    }
    const points = test.points ?? 1;
    // 交互题由 interactor 当裁判，判定规则见 core/compare/interactive.ts。
    const outcome = await interactive.run(
      test.runCmd,
      test.input,
      test.answer,
      this.options.limits,
      token,
    );
    return {
      test: test.testId,
      verdict: outcome.result.verdict,
      score: points * outcome.result.scoreRatio,
      timeMs: outcome.run.wallMs,
      memoryKb: outcome.run.peakMemKb,
      exitCode: outcome.run.exitCode,
      signal: outcome.run.signal,
      message: outcome.result.detail,
      output: outcome.run.stdout,
      answer: test.answer,
    };
  }
}

function runStatusToVerdict(status: RunVerdict): Verdict {
  switch (status) {
    case 'TLE':
      return 'TLE';
    case 'MLE':
      return 'MLE';
    case 'OLE':
      return 'OLE';
    case 'RE':
      return 'RE';
    case 'INTERNAL':
      // 评测流程自身出问题（启动失败等）不是选手程序的错，必须如实上报 UKE。
      return 'UKE';
    case 'OK':
      return 'AC';
  }
}

function describeRunFailure(run: RunResult): string {
  switch (run.status) {
    case 'TLE':
      return `超时（${run.wallMs}ms）`;
    case 'MLE':
      return `内存超限（峰值 ${Math.round(run.peakMemKb / 1024)} MB）`;
    case 'OLE':
      return '输出超限';
    case 'RE':
      return run.signal
        ? `运行时错误（信号 ${run.signal}）`
        : `运行时错误（退出码 ${run.exitCode}）`;
    case 'INTERNAL':
      return firstLine(run.stderr) || '评测内部错误';
    case 'OK':
      return '';
  }
  return '';
}

function firstLine(buffer: Buffer): string {
  const line = buffer
    .toString('utf8')
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  if (line === undefined) {
    return '';
  }
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** 出题人配置有问题时（checker 编译不过、找不到文件）：每个测试点都记 UKE 并说明原因。 */
function allCasesFailed(pkg: ProblemPackage, message: string, startedAt: number): ProblemResult {
  const scored = scoreProblem(pkg.problem, []);
  return {
    problem: pkg.problem.id,
    score: scored.score,
    maxScore: scored.maxScore,
    cases: pkg.problem.tests.map((test) => ({
      test: test.id,
      verdict: 'UKE' as const,
      score: 0,
      timeMs: 0,
      memoryKb: 0,
      exitCode: null,
      signal: null,
      message,
      output: Buffer.alloc(0),
      answer: Buffer.alloc(0),
    })),
    subtasks: scored.subtasks,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 评测整个题目包：逐测试点运行，最后按子任务计分（SPEC §5.5）。
 *
 * 签名比 SPEC §5.5 的草图多收一个 ProblemPackage：测试点路径是相对题目包根目录的，
 * 得先有 rootDir 才能还原成绝对路径。限制与比较方式一律以题目包为准（SPEC §7.1）。
 *
 * 预热不在这里做：那是「产物是不是刚编译出来的」这类知识，属于上层，见 engineFacade 的 prepareRun。
 */
export interface ProblemJudgeContext {
  runCmd: RunCommand;
  /** 编译 checker / interactor 也要用它。 */
  toolchain: Toolchain;
  sandbox: Sandbox;
  cacheDir: string;
  /** testlib.h 所在目录；null / 不给表示没找到（SPEC §6.6）。 */
  testlibDir?: string | null;
  /**
   * 只跑这些测试点（面板上点单个测试点的「运行」时用）。
   *
   * 缺省跑全部；只跑一部分时结果会标 partial：分数只按跑过的那部分算，
   * 是个下界而不是结论，调用方得显式区分。
   */
  onlyTestIds?: string[];
}

export async function judgeProblem(
  pkg: ProblemPackage,
  ctx: ProblemJudgeContext,
  token?: CancellationTokenLike,
  onProgress?: (stage: string) => void,
): Promise<ProblemResult> {
  const startedAt = Date.now();
  const sandbox = ctx.sandbox;

  // 比较器只准备一次：SPJ 要编译 checker，逐测试点编译几十遍纯属浪费。
  const prepared = await prepareComparator(pkg.problem.comparator, {
    packageRoot: pkg.rootDir,
    toolchain: ctx.toolchain,
    sandbox,
    limits: checkerLimits(pkg.problem.limits),
    cacheDir: ctx.cacheDir,
    testlibDir: ctx.testlibDir ?? null,
  });
  if ('error' in prepared) {
    return allCasesFailed(pkg, prepared.error, startedAt);
  }
  if (prepared.note !== undefined) {
    onProgress?.(prepared.note);
  }

  const judge = new Judge(sandbox, {
    limits: pkg.problem.limits,
    comparator: pkg.problem.comparator,
    ...(prepared.comparator === undefined ? {} : { prepared: prepared.comparator }),
    ...(prepared.interactive === undefined ? {} : { interactive: prepared.interactive }),
  });

  const tests =
    ctx.onlyTestIds === undefined
      ? pkg.problem.tests
      : pkg.problem.tests.filter((test) => ctx.onlyTestIds?.includes(test.id) === true);

  const cases: CaseResult[] = [];
  for (const test of tests) {
    if (token?.isCancellationRequested === true) {
      break;
    }

    onProgress?.(`评测 ${test.id}（${cases.length + 1}/${tests.length}）`);
    // 内联样例与数据文件在这里归一成字节，下面一视同仁（§5.4 的按字节比较）。
    const data = await readTestData(pkg, test);
    if ('error' in data) {
      cases.push({
        test: test.id,
        verdict: 'UKE',
        score: 0,
        timeMs: 0,
        memoryKb: 0,
        exitCode: null,
        signal: null,
        // 数据读不到是评测环境的问题，不是选手程序的错；写清是哪个文件读不到。
        message: data.error,
        output: Buffer.alloc(0),
        answer: Buffer.alloc(0),
      });
      continue;
    }
    const { input, answer } = data;

    cases.push(
      await judge.judgeCase(
        { testId: test.id, input, answer, runCmd: ctx.runCmd, points: test.points },
        token,
      ),
    );
  }

  const scored = scoreProblem(pkg.problem, cases);
  return {
    problem: pkg.problem.id,
    score: scored.score,
    maxScore: scored.maxScore,
    cases,
    subtasks: scored.subtasks,
    elapsedMs: Date.now() - startedAt,
    ...(ctx.onlyTestIds === undefined ? {} : { partial: true }),
  };
}
