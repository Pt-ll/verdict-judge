import * as vscode from 'vscode';
import type { CaseResult, Subtask, SubtaskResult, TestCase } from '../core/model';
import { dataFilePath, loadProblem, PROBLEM_FILE, type ProblemPackage } from '../core/problem/package';
import type { JudgeOutcome } from '../engineFacade';
import type { DebugResult } from './debug';
import type { VerdictOutput } from './output';
import { discoverProblemRoots } from './workspace';

const CONTROLLER_ID = 'verdict';
const CONTROLLER_LABEL = 'Verdict';
const RUN_PROFILE_LABEL = '评测';

export interface TestingDeps {
  output: VerdictOutput;
  judgeInPackage: (
    document: vscode.TextDocument,
    request: { problemRoot: string; token?: vscode.CancellationToken },
  ) => Promise<JudgeOutcome | null>;
  /** 起一个调试会话；testId 为空表示用第一个测试点。 */
  debugInPackage: (
    document: vscode.TextDocument,
    problemRoot: string,
    testId?: string,
  ) => Promise<DebugResult>;
}

export interface TestingHandle {
  disposables: vscode.Disposable[];
  /** 重建整棵树；返回的 Promise 在树建好后 resolve（集成测试靠它等发现完成）。 */
  refresh(): Promise<void>;
  /** 顶层测试项，一个题目一项。 */
  roots(): vscode.TestItem[];
  /** 按面板的语义跑一组测试项，返回这次判定的结果。 */
  run(items: vscode.TestItem[], token?: vscode.CancellationToken): Promise<JudgeOutcome | null>;
}

type ItemNode =
  | { kind: 'problem'; pkg: ProblemPackage }
  | { kind: 'subtask'; pkg: ProblemPackage; subtask: Subtask }
  | { kind: 'test'; pkg: ProblemPackage; test: TestCase };

interface Target {
  item: vscode.TestItem;
  node: ItemNode;
}

type JudgedOutcome = Extract<JudgeOutcome, { kind: 'judged' }>;

/**
 * Testing 侧边栏（SPEC §4.4）。
 *
 * 树是「题目 > 子任务 > 测试点」：有子任务时按子任务分组，没被任何子任务收编的测试点
 * 直接挂在题目下面，一个点都不会凭空消失。
 *
 * 跑测试拿哪份源码？M2 还没有选手概念，所以就用当前打开的源文件——这正是
 * 「对当前题目跑当前源码」的意思。M3 引入比赛后，这里会多一层选手。
 */
export function registerTesting(deps: TestingDeps): TestingHandle {
  const controller = vscode.tests.createTestController(CONTROLLER_ID, CONTROLLER_LABEL);
  const nodes = new Map<vscode.TestItem, ItemNode>();

  async function discover(): Promise<void> {
    const packages = await loadPackages();
    nodes.clear();
    controller.items.replace(packages.map((pkg) => buildProblem(pkg)));
  }

  async function loadPackages(): Promise<ProblemPackage[]> {
    const packages: ProblemPackage[] = [];
    for (const root of await discoverProblemRoots()) {
      try {
        packages.push(await loadProblem(root));
      } catch (err) {
        // 一个坏掉的题目包不该让整棵树消失：记一条日志，其余题目照常显示。
        deps.output.error(`题目包 ${root} 无法加载：${messageOf(err)}`);
      }
    }
    return packages.sort((left, right) =>
      left.problem.id.localeCompare(right.problem.id, 'en', { numeric: true }),
    );
  }

  function buildProblem(pkg: ProblemPackage): vscode.TestItem {
    const item = controller.createTestItem(`problem:${pkg.rootDir}`, pkg.problem.name);
    item.description = pkg.problem.id;
    nodes.set(item, { kind: 'problem', pkg });

    const claimed = new Set(pkg.problem.subtasks.flatMap((subtask) => subtask.tests));
    for (const subtask of pkg.problem.subtasks) {
      const node = controller.createTestItem(
        `subtask:${pkg.rootDir}:${subtask.id}`,
        `子任务 ${subtask.id}`,
      );
      node.description = `${subtask.points} 分`;
      nodes.set(node, { kind: 'subtask', pkg, subtask });
      item.children.add(node);

      for (const testId of subtask.tests) {
        const test = pkg.problem.tests.find((candidate) => candidate.id === testId);
        if (test !== undefined) {
          node.children.add(buildTest(pkg, test));
        }
      }
    }
    for (const test of pkg.problem.tests) {
      if (!claimed.has(test.id)) {
        item.children.add(buildTest(pkg, test));
      }
    }
    return item;
  }

  function buildTest(pkg: ProblemPackage, test: TestCase): vscode.TestItem {
    // 点一下就能跳到这个测试点的输入文件，省得在资源管理器里翻。
    // uri 只能在创建时给（它是只读的），range 可以后设。
    const item = controller.createTestItem(
      `test:${pkg.rootDir}:${test.id}`,
      `#${test.id}`,
      // 数据可能在总库里，不在题目包里面——路径一律走同一个解析函数。
      vscode.Uri.file(dataFilePath(pkg, test.input)),
    );
    item.description = `${test.points ?? 1} 分`;
    item.range = new vscode.Range(0, 0, 0, 0);
    nodes.set(item, { kind: 'test', pkg, test });
    return item;
  }

  /** 顶层测试项。TestItemCollection 的迭代器给的是 [id, item] 对，这里取 item。 */
  function rootItems(): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    controller.items.forEach((item) => items.push(item));
    return items;
  }

  function collect(items: readonly vscode.TestItem[]): Target[] {
    const targets: Target[] = [];
    for (const item of items) {
      const node = nodes.get(item);
      if (node !== undefined) {
        targets.push({ item, node });
      }
    }
    return targets;
  }

  function collectTestIds(items: readonly vscode.TestItem[]): string[] {
    const ids: string[] = [];
    const visit = (item: vscode.TestItem): void => {
      const node = nodes.get(item);
      if (node?.kind === 'test') {
        ids.push(node.test.id);
      }
      item.children.forEach(visit);
    };
    items.forEach(visit);
    return ids;
  }

  async function execute(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<JudgeOutcome | null> {
    const run = controller.createTestRun(request);
    try {
      return await runTargets(
        collect(request.include ?? rootItems()),
        new Set(collectTestIds(request.exclude ?? [])),
        run,
        token,
      );
    } finally {
      run.end();
    }
  }

  async function runTargets(
    targets: Target[],
    excludedTests: Set<string>,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
  ): Promise<JudgeOutcome | null> {
    const selected = targets.filter(
      (target) => target.node.kind !== 'test' || !excludedTests.has(target.node.test.id),
    );
    if (selected.length === 0) {
      return null;
    }

    const roots = new Set(selected.map((target) => target.node.pkg.rootDir));
    if (roots.size > 1) {
      // 一次跑多个题目属于「评测全部」，那是 M3 的 judgeAll。
      errorAll(run, selected, '一次只能评测一个题目，请分开运行。');
      return null;
    }

    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined || document.uri.scheme !== 'file') {
      errorAll(run, selected, '请先打开要评测的源码文件，再运行测试。');
      return null;
    }

    run.appendOutput(`开始评测：${document.uri.fsPath}\r\n`);
    const outcome = await deps.judgeInPackage(document, {
      problemRoot: [...roots][0] ?? '',
      token,
    });
    if (outcome === null) {
      errorAll(run, selected, '评测没有产生结果（可能已被取消）。');
      return null;
    }

    report(run, selected, outcome);
    return outcome;
  }

  function report(run: vscode.TestRun, targets: Target[], outcome: JudgeOutcome): void {
    if (outcome.kind !== 'judged') {
      const reason =
        outcome.kind === 'compile-failed'
          ? compileFailureText(outcome)
          : (outcome.message ?? '没有可用的测试数据');
      errorAll(run, targets, reason);
      return;
    }

    const cases = new Map(outcome.cases.map((item) => [item.test, item]));
    const subtasks = new Map(outcome.subtasks.map((item) => [item.id, item]));

    for (const target of targets) {
      switch (target.node.kind) {
        case 'test': {
          const result = cases.get(target.node.test.id);
          // 被取消的评测可能没跑到这个点：如实标成「跳过」，不假装它过了或者挂了。
          if (result === undefined) {
            run.skipped(target.item);
          } else {
            reportCase(run, target.item, result);
          }
          break;
        }
        case 'subtask': {
          const result = subtasks.get(target.node.subtask.id);
          if (result === undefined) {
            run.skipped(target.item);
          } else {
            reportSubtask(run, target.item, result);
          }
          break;
        }
        case 'problem':
          reportProblem(run, target.item, outcome);
          break;
      }
    }
    run.appendOutput(`得分：${outcome.score}/${outcome.maxScore}\r\n`);
  }

  const runProfile = controller.createRunProfile(
    RUN_PROFILE_LABEL,
    vscode.TestRunProfileKind.Run,
    (request, token) => {
      void execute(request, token);
    },
    true,
  );

  // 调试首测点（SPEC §4.4）：与运行 profile 共用同一套「当前文件 + 指定题目包」的语义，
  // 只是把编译参数换成调试版，并顺手把测试点输入接到 stdin 上。
  async function runDebug(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<DebugResult | null> {
    const run = controller.createTestRun(request);
    try {
      const targets = collect(request.include ?? rootItems());
      const first = targets[0];
      if (first === undefined) {
        return null;
      }

      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined || document.uri.scheme !== 'file') {
        errorAll(run, targets, '请先打开要调试的源码文件，再启动调试。');
        return null;
      }

      const result = await deps.debugInPackage(
        document,
        first.node.pkg.rootDir,
        firstTestId(first.node),
      );
      if (result.kind === 'started') {
        run.passed(first.item);
        run.appendOutput(
          `调试已启动：测试点 #${result.testId}，程序 ${result.program}\r\n`,
        );
      } else {
        errorAll(run, targets, result.message);
      }
      void token;
      return result;
    } finally {
      // 只结束「测试运行」的展示；调试会话本身继续跑，用户还要在里面单步。
      run.end();
    }
  }

  function firstTestId(node: ItemNode): string | undefined {
    switch (node.kind) {
      case 'test':
        return node.test.id;
      case 'subtask':
        return node.subtask.tests[0];
      case 'problem':
        return undefined;
    }
  }

  const debugProfile = controller.createRunProfile(
    '调试首测点',
    vscode.TestRunProfileKind.Debug,
    (request, token) => {
      void runDebug(request, token);
    },
    false,
  );

  // 题目包在编辑器外面被改动（git 切分支、手改 problem.json）时，把树刷新一遍。
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${PROBLEM_FILE}`);
  watcher.onDidCreate(() => void discover());
  watcher.onDidChange(() => void discover());
  watcher.onDidDelete(() => void discover());

  return {
    disposables: [controller, runProfile, debugProfile, watcher],
    refresh: discover,
    roots: rootItems,
    run: (items, token) => {
      // 从代码调用时没有 TestRunRequest，自己造一个：行为与点面板上的按钮完全一致。
      const fallback = new vscode.CancellationTokenSource();
      const request = new vscode.TestRunRequest(items);
      return execute(request, token ?? fallback.token).finally(() => fallback.dispose());
    },
  };
}

function reportCase(run: vscode.TestRun, item: vscode.TestItem, result: CaseResult): void {
  const duration = result.timeMs;
  if (result.verdict === 'AC') {
    run.passed(item, duration);
    return;
  }
  const message = new vscode.TestMessage(caseText(result));
  if (result.verdict === 'UKE') {
    run.errored(item, message, duration);
    return;
  }
  run.failed(item, message, duration);
}

function reportSubtask(
  run: vscode.TestRun,
  item: vscode.TestItem,
  result: SubtaskResult,
): void {
  if (result.status === 'full') {
    run.passed(item);
    return;
  }
  const why =
    result.status === 'skipped'
      ? '依赖未满足，已跳过'
      : result.status === 'partial'
        ? '部分分'
        : '未得分';
  run.failed(item, new vscode.TestMessage(`${result.score}/${result.maxScore} 分（${why}）`));
}

function reportProblem(
  run: vscode.TestRun,
  item: vscode.TestItem,
  outcome: JudgedOutcome,
): void {
  const accepted = outcome.cases.filter((entry) => entry.verdict === 'AC').length;
  const allPassed = outcome.cases.length > 0 && accepted === outcome.cases.length;
  if (allPassed) {
    run.passed(item);
    return;
  }
  run.failed(
    item,
    new vscode.TestMessage(
      `${outcome.score}/${outcome.maxScore} 分，AC ${accepted}/${outcome.cases.length}`,
    ),
  );
}

function caseText(result: CaseResult): string {
  const parts = [result.verdict, `${result.timeMs}ms`];
  if (result.memoryKb > 0) {
    parts.push(`${(result.memoryKb / 1024).toFixed(1)}MB`);
  }
  if (result.message !== undefined && result.message.length > 0) {
    parts.push(result.message);
  }
  return parts.join('  ');
}

function compileFailureText(outcome: Extract<JudgeOutcome, { kind: 'compile-failed' }>): string {
  const first = outcome.compile.diagnostics.find((item) => item.severity === 'error');
  return first === undefined
    ? '编译失败，详见问题面板'
    : `编译失败：${first.file}:${first.line}:${first.column} ${first.message}`;
}

function errorAll(run: vscode.TestRun, targets: Target[], message: string): void {
  for (const target of targets) {
    run.errored(target.item, new vscode.TestMessage(message));
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
