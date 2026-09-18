import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addProblemToContest,
  findContestRoot,
  listContests,
  loadContest,
  removeProblemFromContest,
  saveContest,
  type ContestRef,
} from '../core/contest/contest';
import type { Problem } from '../core/model';
import { dataRootOf, problemDirOf, problemsDirOf } from '../core/layout';
import { exportProblemPackage, importProblemPackage } from '../core/problem/archive';
import { clearSubtasks, evenSubtasks, planAddTests, withLimits } from '../core/problem/edit';
import {
  loadProblem,
  PROBLEM_FILE,
  saveProblem,
  sharedDataDir,
  type ProblemPackage,
} from '../core/problem/package';
import type { CaseDocumentStore } from './caseDocs';
import type { VerdictOutput } from './output';
import { activeProblemRoot, discoverProblemRoots, workspaceRoot } from './workspace';

export const COMMAND_ADD_TESTS = 'verdict.addTests';
export const COMMAND_CONFIGURE_SUBTASKS = 'verdict.configureSubtasks';
export const COMMAND_SET_LIMITS = 'verdict.setLimits';
export const COMMAND_SHOW_DIFF = 'verdict.showDiff';
export const COMMAND_EXPORT_PROBLEM = 'verdict.exportProblem';
export const COMMAND_IMPORT_PROBLEM = 'verdict.importProblem';
export const COMMAND_DELETE_PROBLEM = 'verdict.deleteProblem';
export const COMMAND_ADD_PROBLEM_TO_CONTEST = 'verdict.addProblemToContest';
export const COMMAND_REMOVE_PROBLEM_FROM_CONTEST = 'verdict.removeProblemFromContest';

export interface ProblemCommandDeps {
  output: VerdictOutput;
  caseDocs: CaseDocumentStore;
  /** 题目包被改动后刷新 Testing 树。 */
  refreshTests: () => Promise<void>;
  /** 当前在用的是哪一场比赛（面板里选的那场）；没有比赛时为 null。 */
  activeContestId: () => string | null;
}

/**
 * 改题目包的那几个命令（SPEC §4.1）。
 *
 * 所有写操作都通过 saveProblem 落到 problem.json，绝不碰数据文件与选手源码。
 * 真正的逻辑在 core/problem/edit.ts 里（纯函数、可单测），这里只负责收集输入与提示。
 */
export function registerProblemCommands(deps: ProblemCommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMAND_ADD_TESTS, guard(deps, addTests)),
    vscode.commands.registerCommand(COMMAND_CONFIGURE_SUBTASKS, guard(deps, configureSubtasks)),
    vscode.commands.registerCommand(COMMAND_SET_LIMITS, guard(deps, setLimits)),
    vscode.commands.registerCommand(COMMAND_SHOW_DIFF, guard(deps, showDiff)),
    vscode.commands.registerCommand(COMMAND_EXPORT_PROBLEM, guard(deps, exportProblem)),
    vscode.commands.registerCommand(COMMAND_IMPORT_PROBLEM, guard(deps, importProblem)),
    vscode.commands.registerCommand(COMMAND_DELETE_PROBLEM, (arg?: unknown) =>
      guard(deps, () => deleteProblem(deps, asProblemId(arg)))(),
    ),
    vscode.commands.registerCommand(COMMAND_ADD_PROBLEM_TO_CONTEST, (arg?: unknown) =>
      guard(deps, () => addToActiveContest(deps, asProblemId(arg)))(),
    ),
    vscode.commands.registerCommand(COMMAND_REMOVE_PROBLEM_FROM_CONTEST, (arg?: unknown) =>
      guard(deps, () => removeFromActiveContest(deps, asProblemId(arg)))(),
    ),
  ];
}

/** 命令出错时别静默：通知里给第一行，完整内容（problem.json 的问题是分行列的）进输出通道。 */
function guard(
  deps: ProblemCommandDeps,
  run: (deps: ProblemCommandDeps) => Promise<void>,
): () => Promise<void> {
  return async () => {
    try {
      await run(deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.output.error(`命令失败：\n${message}`);
      const firstLine = message.split('\n')[0] ?? message;
      void vscode.window
        .showErrorMessage(`Verdict：${firstLine}`, '查看输出')
        .then((choice) => {
          if (choice === '查看输出') {
            deps.output.show();
          }
        });
    }
  };
}

async function addTests(deps: ProblemCommandDeps): Promise<void> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    return;
  }

  const plan = await planAddTests(pkg);
  if (plan.added.length === 0) {
    deps.output.info(`没有新的测试点：${pkg.dataDir} 里的数据都已登记。`);
    void vscode.window.showInformationMessage('Verdict：没有发现新的测试点。');
    return;
  }

  const names = plan.added.map((test) => test.id).join('、');
  const choice = await vscode.window.showInformationMessage(
    `Verdict：发现 ${plan.added.length} 个新测试点（${names}），登记进 problem.json？`,
    '登记',
  );
  if (choice !== '登记') {
    return;
  }

  pkg.problem.tests = plan.tests;
  await saveProblem(pkg);
  await afterChange(deps, `已登记 ${plan.added.length} 个测试点：${names}。`);
}

async function configureSubtasks(deps: ProblemCommandDeps): Promise<void> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    return;
  }
  if (pkg.problem.tests.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：这个题目还没有测试点，先执行「Verdict: 导入测试点」。',
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      { label: '按测试点均分', detail: '把测试点按顺序分成几组，组内全对才给分' },
      { label: '清空子任务', detail: '所有测试点直接计入总分' },
      { label: '打开 problem.json 手动编辑', detail: '细调分值、依赖与计分方式' },
    ],
    { title: 'Verdict：配置子任务' },
  );
  if (pick === undefined) {
    return;
  }

  if (pick.label === '打开 problem.json 手动编辑') {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(pkg.rootDir, PROBLEM_FILE)));
    return;
  }

  if (pick.label === '清空子任务') {
    pkg.problem.subtasks = [];
    // 测试点上的 subtask 字段要一起清掉：留着它下次加载就会因「两边不一致」报错。
    pkg.problem.tests = clearSubtasks(pkg.problem.tests);
    await saveProblem(pkg);
    await afterChange(deps, '已清空子任务，所有测试点直接计入总分。');
    return;
  }

  const total = pkg.problem.tests.length;
  const groups = await vscode.window.showInputBox({
    title: 'Verdict：分成几个子任务',
    value: String(Math.min(2, total)),
    validateInput: (text) => {
      const count = Number.parseInt(text, 10);
      return Number.isInteger(count) && count >= 1 && count <= total
        ? undefined
        : `请输入 1 到 ${total} 之间的整数`;
    },
  });
  if (groups === undefined) {
    return;
  }

  const plan = evenSubtasks(pkg.problem.tests, Number.parseInt(groups, 10));
  pkg.problem.subtasks = plan.subtasks;
  pkg.problem.tests = plan.tests;
  await saveProblem(pkg);
  await afterChange(
    deps,
    `已分成 ${plan.subtasks.length} 个子任务：` +
      `${plan.subtasks.map((item) => `${item.id}（${item.points} 分）`).join('、')}。` +
      '分值、依赖与计分方式可以在 problem.json 里细调。',
  );
}

async function setLimits(deps: ProblemCommandDeps): Promise<void> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    return;
  }

  const { limits } = pkg.problem;
  const timeMs = await askNumber('时间限制（毫秒）', limits.timeMs, (value) => value > 0);
  if (timeMs === undefined) {
    return;
  }
  const memoryMb = await askNumber('内存限制（MB）', limits.memoryMb, (value) => value > 0);
  if (memoryMb === undefined) {
    return;
  }
  const outputKb = await askNumber('输出上限（KB）', limits.outputKb, (value) => value >= 0);
  if (outputKb === undefined) {
    return;
  }

  // 栈上限跟着内存走：SPEC §6.3 的示例就是配套的，分两处填只会让人多按一次回车。
  pkg.problem = withLimits(pkg.problem, { timeMs, memoryMb, stackMb: memoryMb, outputKb });
  await saveProblem(pkg);
  await afterChange(
    deps,
    `已设置限制：${timeMs}ms、${memoryMb}MB、输出上限 ${outputKb}KB（栈上限同内存）。`,
  );
}

async function showDiff(deps: ProblemCommandDeps): Promise<void> {
  const owner = await currentOwner();
  if (owner === null) {
    void vscode.window.showWarningMessage('Verdict：请先打开要对比的源码文件。');
    return;
  }

  const cases = deps.caseDocs.casesOf(owner);
  if (cases.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：还没有这个题目的评测结果，先跑一次评测再来对比输出。',
    );
    return;
  }

  // 失败的点排在前面：要对比的多半是挂掉的那个。
  const failed = cases.filter((item) => item.verdict === 'WA' || item.verdict === 'PC');
  const pool = failed.length > 0 ? failed : cases;
  const picked = await vscode.window.showQuickPick(
    pool.map((item) => ({
      label: `#${item.test}`,
      description:
        `${item.verdict}` +
        (item.firstDiffLine === undefined ? '' : `  第 ${item.firstDiffLine} 行不同`),
      detail: item.message,
      result: item,
    })),
    { title: 'Verdict：对比哪个测试点' },
  );
  if (picked === undefined) {
    return;
  }
  await deps.caseDocs.openDiff(owner, picked.result.test, picked.result.firstDiffLine);
}

async function askNumber(
  label: string,
  current: number,
  acceptable: (value: number) => boolean,
): Promise<number | undefined> {
  const text = await vscode.window.showInputBox({
    title: `Verdict：设置限制 - ${label}`,
    value: String(current),
    validateInput: (input) => {
      const value = Number.parseInt(input, 10);
      return Number.isInteger(value) && acceptable(value) ? undefined : '请输入一个合法的整数';
    },
  });
  return text === undefined ? undefined : Number.parseInt(text, 10);
}

/** showDiff 用的标识：与 commands.ts 记录结果时用的是同一套（题目 id 或源文件名）。 */
async function currentOwner(): Promise<string | null> {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined || document.uri.scheme !== 'file') {
    return null;
  }
  const root = await activeProblemRoot();
  if (root === null) {
    return path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
  }
  return (await loadProblem(root)).problem.id;
}

/**
 * 确定这次操作哪个题目包：优先当前文件所属的，其次工作区里唯一/用户选中的那个。
 *
 * 不做「猜」：一个工作区里有多个题目包、当前文件又不在任何一个里面时，
 * 必须让用户明确选一个，改错文件比多按一次回车糟糕得多。
 */
async function resolvePackage(): Promise<ProblemPackage | null> {
  const root = await activeProblemRoot();
  if (root !== null) {
    return await loadProblem(root);
  }

  const roots = await discoverProblemRoots();
  if (roots.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：工作区里没有题目包。在题目目录里放一个 problem.json，或执行「Verdict: 新建题目」。',
    );
    return null;
  }
  if (roots.length === 1) {
    return await loadProblem(roots[0] ?? '');
  }

  const base = workspaceRoot() ?? '';
  const picked = await vscode.window.showQuickPick(
    roots.map((item) => ({
      label: path.basename(item),
      description: path.relative(base, item),
      root: item,
    })),
    { title: 'Verdict：对哪个题目操作' },
  );
  return picked === undefined ? null : await loadProblem(picked.root);
}

/** 同 resolvePackage，但把它「没得可选」的情形直接当成错误抛出去。 */
async function requirePackage(): Promise<ProblemPackage> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    throw new Error('没有可操作的题目包。');
  }
  return pkg;
}

async function afterChange(deps: ProblemCommandDeps, message: string): Promise<void> {
  await deps.refreshTests();
  deps.output.info(message);
  void vscode.window.showInformationMessage(`Verdict：${message}`);
}

/** 导出题目包：选一个 .zip 路径，把整个题目目录（含 extra/）打包。 */
async function exportProblem(deps: ProblemCommandDeps): Promise<void> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    return;
  }

  const picked = await vscode.window.showSaveDialog({
    title: 'Verdict：导出题目包',
    defaultUri: vscode.Uri.file(path.join(path.dirname(pkg.rootDir), `${pkg.problem.id}.zip`)),
    filters: { 题目包: ['zip'] },
  });
  if (picked === undefined) {
    return;
  }

  const result = await exportProblemPackage(pkg, picked.fsPath);
  deps.output.info(
    `已导出题目包：${result.zipPath}（${String(result.entries)} 个文件，` +
      `${(result.bytes / 1024).toFixed(1)}KB）`,
  );
  void vscode.window.showInformationMessage(
    `Verdict：已导出「${pkg.problem.name}」（${String(result.entries)} 个文件）。`,
  );
}

/** 导入题目包：解到工作区的 .verdict/problems/ 下，并加进当前比赛（如果有比赛）。 */
async function importProblem(deps: ProblemCommandDeps): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Verdict：选择题目包压缩文件',
    canSelectMany: false,
    filters: { 题目包: ['zip'] },
  });
  const archive = picked?.[0]?.fsPath;
  if (archive === undefined) {
    return;
  }

  const root = workspaceRoot();
  // 有工作区就按 SPEC §6.1 的布局放；没有就解到压缩包旁边，别让人找不到它。
  const destination =
    root === undefined ? path.dirname(archive) : problemsDirOf(root);
  const imported = await importProblemPackage(archive, destination);

  // 有工作区就把数据搬进总库：解出来的包自带 data/ 也能用，但那样每道题的数据
  // 会散落在各自的题目包里，跟「一个总数据目录」的布局对不上。
  const relocated = root === undefined ? null : await moveDataToLibrary(root, imported.package);
  const problem = (await loadProblem(imported.rootDir)).problem;

  await addToContestIfPresent(deps, root, problem);
  await deps.refreshTests();
  deps.output.info(
    `已导入题目 ${problem.id}：${imported.rootDir}` +
      (relocated === null ? '' : `（数据已放进总库：${relocated}）`),
  );
  void vscode.window.showInformationMessage(
    `Verdict：已导入题目「${problem.name}」。`,
  );
}

/**
 * 把导入进来的题目包里的 data/ 搬进总库（.verdict/data/<题目 id>）。
 *
 * 不做这件事也能跑：包内的 data/ 依然会被认成数据目录。但导入的题目如果留在
 * 自己的 data/ 里，工作区就有了两套并存的布局，用户下次找数据要猜在哪。
 */
async function moveDataToLibrary(
  root: string,
  pkg: ProblemPackage,
): Promise<string | null> {
  const source = path.join(pkg.rootDir, 'data');
  const target = path.join(dataRootOf(root), pkg.problem.id);
  if (source === target || !(await isDirectory(source))) {
    return null;
  }
  if (await exists(target)) {
    // 总库里已经有这个题目的数据就当已经有了，别盖掉——导入方多半是想加一道新题。
    return null;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.rename(source, target);
  } catch {
    // 跨卷时 rename 会失败，退回「复制再删」。
    await fs.promises.cp(source, target, { recursive: true });
    await fs.promises.rm(source, { recursive: true, force: true });
  }
  return target;
}

/**
 * 新建 / 导入的题目顺手加进当前的比赛。
 *
 * 在比赛工作区里加题，绝大多数情况就是「要拿它比赛」；不想要也可以从 contest.json 的
 * problems 里删掉。这里直接读写文件而不经过 ContestSession——那个会话每次命令都会重读，
 * 所以不会出现「刚加的题目没生效」。
 */
async function addToContestIfPresent(
  deps: ProblemCommandDeps,
  root: string | undefined,
  problem: Problem,
): Promise<void> {
  if (root === undefined) {
    return;
  }
  const contestRoot = await findContestRoot(root, root);
  if (contestRoot === null) {
    return;
  }
  const pkg = await loadContest(contestRoot, deps.activeContestId() ?? undefined);
  if (pkg.contest.problems.some((item) => item.id === problem.id)) {
    return;
  }
  pkg.contest = addProblemToContest(pkg.contest, problem);
  await saveContest(pkg);
  deps.output.info(`已把题目 ${problem.id} 加入比赛「${pkg.contest.title}」`);
}

/** 把工作区里已有的题目加进当前比赛——多场比赛共用同一个题目库，题目重叠是常态。 */
async function addToActiveContest(
  deps: ProblemCommandDeps,
  problemId: string | null,
): Promise<void> {
  const root = workspaceRoot();
  if (root === undefined) {
    throw new Error('请先打开一个文件夹作为工作区。');
  }
  const contestRoot = await findContestRoot(root, root);
  if (contestRoot === null) {
    throw new Error('这个工作区里还没有比赛。先执行「Verdict: 新建比赛」。');
  }
  const pkg = await loadContest(contestRoot, deps.activeContestId() ?? undefined);
  const target = problemId ?? (await requirePackage()).problem.id;
  if (pkg.contest.problems.some((item) => item.id === target)) {
    deps.output.info(`题目 ${target} 已经在比赛「${pkg.contest.title}」里了。`);
    return;
  }
  const problem = (await loadProblem(problemDirOf(root, target))).problem;
  pkg.contest = addProblemToContest(pkg.contest, problem);
  await saveContest(pkg);
  await deps.refreshTests();
  deps.output.info(`已把题目 ${target} 加入比赛「${pkg.contest.title}」`);
  void vscode.window.showInformationMessage(
    `Verdict：题目 ${target} 已加入比赛「${pkg.contest.title}」。`,
  );
}

/** 把一道题从当前比赛摘掉（题目包与数据都留着，别的比赛也不受影响）。 */
async function removeFromActiveContest(
  deps: ProblemCommandDeps,
  problemId: string | null,
): Promise<void> {
  const root = workspaceRoot();
  if (root === undefined) {
    throw new Error('请先打开一个文件夹作为工作区。');
  }
  const contestRoot = await findContestRoot(root, root);
  if (contestRoot === null) {
    throw new Error('这个工作区里还没有比赛。');
  }
  const pkg = await loadContest(contestRoot, deps.activeContestId() ?? undefined);
  const target = problemId ?? (await requirePackage()).problem.id;
  if (!pkg.contest.problems.some((item) => item.id === target)) {
    deps.output.info(`题目 ${target} 本来就不在比赛「${pkg.contest.title}」里。`);
    return;
  }
  pkg.contest = removeProblemFromContest(pkg.contest, target);
  await saveContest(pkg);
  await deps.refreshTests();
  deps.output.info(`已把题目 ${target} 从比赛「${pkg.contest.title}」里移除（题目包与数据都还在）。`);
  void vscode.window.showInformationMessage(
    `Verdict：题目 ${target} 已从比赛「${pkg.contest.title}」移除，题目包与数据保留。`,
  );
}

/**
 * 删除一道题。
 *
 * 三个选项对应三种真实意图：只是这场比赛不考它了 / 题目本身不要了 /
 * 连数据一起清掉。后两种都要先把题目从**所有**比赛里摘掉，否则那些比赛
 * 下次加载会因为「题目包不存在」直接报错——删一道题不该把别的比赛弄坏。
 */
async function deleteProblem(
  deps: ProblemCommandDeps,
  problemId: string | null,
): Promise<void> {
  const pkg = problemId === null ? await resolvePackage() : await loadById(problemId);
  if (pkg === null) {
    return;
  }
  const root = workspaceRoot();
  const owners = root === undefined ? [] : await contestsOwning(root, pkg.problem.id);
  const shared = sharedDataDir(pkg.rootDir);
  const dataInsideWorkspace =
    root !== undefined &&
    (shared !== null ? shared === pkg.dataDir : pkg.dataDir === path.join(pkg.rootDir, 'data'));

  const detail = [
    `题目包：${pkg.rootDir}`,
    `数据目录：${pkg.dataDir}${dataInsideWorkspace ? '' : '（不在工作区内，不会被删）'}`,
    owners.length === 0
      ? '当前没有比赛在用它。'
      : `有 ${String(owners.length)} 场比赛在用它：${owners.map((item) => item.id).join('、')}。`,
  ].join('\n');

  const items = [
    ...(owners.length > 0 ? ['只从比赛移除'] : []),
    '删除题目包（保留数据）',
    ...(dataInsideWorkspace ? ['连数据一起删除'] : []),
  ];
  const picked = await vscode.window.showWarningMessage(
    `Verdict：删除题目「${pkg.problem.name}」？`,
    { modal: true, detail },
    ...items,
  );
  if (picked === undefined) {
    return;
  }

  if (picked === '只从比赛移除') {
    await dropFromContests(deps, root, pkg.problem.id);
    return;
  }

  await dropFromContests(deps, root, pkg.problem.id);
  const withData = picked === '连数据一起删除';
  const failures: string[] = [];
  if (withData && !(await removePath(pkg.dataDir))) {
    failures.push(pkg.dataDir);
  }
  if (!(await removePath(pkg.rootDir))) {
    failures.push(pkg.rootDir);
  }

  await deps.refreshTests();
  if (failures.length > 0) {
    throw new Error(`没能删除：${failures.join('、')}。文件可能被占用或权限不足。`);
  }

  deps.output.info(
    `已删除题目 ${pkg.problem.id}` +
      (withData ? `（含数据 ${pkg.dataDir}）` : '（数据保留）') +
      `，文件已移入回收站。`,
  );
  void vscode.window.showInformationMessage(
    `Verdict：题目「${pkg.problem.name}」已删除${withData ? '（含数据）' : '，数据保留'}。`,
  );
}

/** 把题目从所有还列着它的比赛里摘掉，返回被摘掉的比赛。 */
async function contestsOwning(root: string, problemId: string): Promise<ContestRef[]> {
  const refs = await listContests(root);
  const owners: ContestRef[] = [];
  for (const ref of refs) {
    const pkg = await loadContest(root, ref.id).catch(() => null);
    if (pkg !== null && pkg.contest.problems.some((item) => item.id === problemId)) {
      owners.push(ref);
    }
  }
  return owners;
}

async function dropFromContests(
  deps: ProblemCommandDeps,
  root: string | undefined,
  problemId: string,
): Promise<void> {
  if (root === undefined) {
    return;
  }
  const owners = await contestsOwning(root, problemId);
  for (const ref of owners) {
    const pkg = await loadContest(root, ref.id);
    pkg.contest = removeProblemFromContest(pkg.contest, problemId);
    await saveContest(pkg);
    deps.output.info(`已把题目 ${problemId} 从比赛「${pkg.contest.title}」里移除。`);
  }
}

/** 删除文件或目录：优先移进回收站，回收站不可用（某些远程文件系统）时退回直接删除。 */
async function removePath(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(target), {
      recursive: true,
      useTrash: true,
    });
    return true;
  } catch {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return !(await exists(target));
    } catch {
      return false;
    }
  }
}

/** 按 id 找一个题目包；找不到时给一句人话，而不是让 loadProblem 抛路径错误。 */
async function loadById(problemId: string): Promise<ProblemPackage | null> {
  const root = workspaceRoot();
  if (root === undefined) {
    throw new Error('请先打开一个文件夹作为工作区。');
  }
  const dir = problemDirOf(root, problemId);
  if (!(await exists(path.join(dir, PROBLEM_FILE)))) {
    throw new Error(`找不到题目包：${dir}`);
  }
  return loadProblem(dir);
}

function asProblemId(arg: unknown): string | null {
  return typeof arg === 'string' && arg.length > 0 ? arg : null;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}
