import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ComparatorConfig, Limits } from '../core/model';
import { summarizeVerdict } from '../core/model';
import {
  addSubtask,
  clearSubtasks,
  evenSubtasks,
  planAddTests,
  removeSubtask,
  removeTest,
  setTestSubtask,
  updateSubtask,
  validateLimits,
  withComparator,
  withLimits,
  type SubtaskPatch,
} from '../core/problem/edit';
import {
  loadProblem,
  PROBLEM_FILE,
  saveProblem,
  type ProblemPackage,
} from '../core/problem/package';
import type { JudgeOutcome } from '../engineFacade';
import type { CaseDocumentStore } from './caseDocs';
import type { VerdictCommands } from './commands';
import { CONTEST_FILE, VERDICT_DIR } from '../core/contest/contest';
import type { ContestSession } from './contest';
import { debugFailureText, startDebug } from './debug';
import type { VerdictOutput } from './output';
import { workspaceRoot } from './workspace';
import { createNonce, panelHtml } from './panel/html';
import { collectPanelState, type PanelStandings, type PanelState } from './panel/state';

/** 活动栏里那个容器的视图 id，与 package.json 的 contributes.views 对应。 */
export const VIEW_ID = 'verdict.controlPanel';

/** 面板上允许触发的命令。写死清单，免得面板里出现什么就能执行什么。 */
const ALLOWED_COMMANDS = new Set([
  'verdict.newContest',
  'verdict.switchContest',
  'verdict.newProblem',
  'verdict.importProblem',
  'verdict.exportProblem',
  'verdict.deleteProblem',
  'verdict.addProblemToContest',
  'verdict.removeProblemFromContest',
  'verdict.judgeAll',
  'verdict.showStandings',
  'verdict.exportHtml',
  'verdict.cancel',
]);

export interface ControlPanelDeps {
  context: vscode.ExtensionContext;
  output: VerdictOutput;
  caseDocs: CaseDocumentStore;
  commands: Pick<VerdictCommands, 'judgeDocumentInPackage'>;
  contest: ContestSession;
  /** 题目包被改动后刷新 Testing 树（面板与 Testing 面板看同一份数据）。 */
  refreshTests: () => Promise<void>;
}

/**
 * 活动栏侧边栏里的操作面板（SPEC §4.12）。
 *
 * 定位是「不写 JSON 也能把整套流程点完」：题目与测试点在面板里看得见、点得动，
 * 限制与比较方式在面板里改，评测、调试、重测、榜单都在手边。但 JSON 仍然是唯一的
 * 存储格式——面板的每次编辑都是「读 problem.json → 改内存里的对象 → 写回」，
 * 与手改文件完全等价，两边因此不会各说各话。
 */
export class VerdictControlPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private selectedProblemId: string | null = null;
  private lastState: PanelState | null = null;
  private busy: string | null = null;
  private notice: PanelState['notice'] = null;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ControlPanelDeps) {}

  /** 注册视图、文件监听与「别处改了数据」的刷新钩子。 */
  register(): vscode.Disposable[] {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      // 面板的每次编辑都会写 problem.json；反过来说，编辑器里手改、git 切分支、
      // 或者别的窗口改了这些文件，面板也得跟着变，否则显示的是过期数据。
      watchJsonFiles(() => void this.onFilesChanged()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === 'file') {
          this.scheduleRefresh();
        }
      }),
      this.deps.caseDocs.onDidRecord(() => this.scheduleRefresh()),
    );
    return this.disposables;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = panelHtml(createNonce());

    this.disposeView();
    this.viewDisposables = [
      view.webview.onDidReceiveMessage((message: unknown) => {
        void this.onMessage(message);
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          void this.refresh();
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    ];
  }

  /** 面板开着才做的事：重读磁盘上的配置并推过去。 */
  async refresh(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    await this.recompute();
  }

  /** 不管面板开没开都重算一遍（面板消息、集成测试走这里）。 */
  private async recompute(): Promise<void> {
    let state: PanelState;
    try {
      // 强制重读比赛：contest.json、submissions.json 都可能在编辑器外面被改。
      await this.deps.contest.load(true);
      state = await collectPanelState(
        {
          caseDocs: this.deps.caseDocs,
          standings: () => this.standingsState(),
          activeContestId: () => this.deps.contest.activeId(),
        },
        this.selectedProblemId,
        { busy: this.busy, notice: this.notice },
      );
    } catch (err) {
      // 采集失败也必须发一份数据过去：以前这里是直接抛，面板收不到任何东西，
      // 就永远停在「正在读取评测配置…」——用户看到的就是「侧边栏一片空白」。
      const text = firstLine(err);
      this.deps.output.error(`面板刷新失败：${text}`);
      state = {
        contest: null,
        problems: [],
        selected: null,
        source: null,
        standings: null,
        busy: this.busy,
        notice: { level: 'error', text },
      };
    }
    this.lastState = state;
    if (state.selected !== null) {
      this.selectedProblemId = state.selected.id;
    }
    this.send({ type: 'data', payload: state });
  }

  /** 面板最近一次算出来的状态（集成测试与调试用）。 */
  state(): PanelState | null {
    return this.lastState;
  }

  /** 把一条面板消息交给它处理，等价于 webview 里 postMessage 过来的那条。 */
  async dispatch(message: unknown): Promise<void> {
    await this.onMessage(message);
  }

  /**
   * 攒一小会儿再刷新。
   *
   * 编辑器事件来得很密（每敲一个字就有一次），而每次都去读一遍 problem.json、
   * contest.json 纯属白干；面板看到的东西晚 150ms 也没有任何人会察觉。
   */
  private scheduleRefresh(): void {
    // 面板从没打开过就什么都不用算：这些事件（打字、切文件、跑完一次评测）本来就勤，
    // 没人在看的时候读一遍题目包纯属白干。
    if (this.view === undefined) {
      return;
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 150);
  }

  dispose(): void {
    this.disposeView();
    for (const item of this.disposables) {
      item.dispose();
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
  }

  private disposeView(): void {
    for (const item of this.viewDisposables) {
      item.dispose();
    }
    this.viewDisposables = [];
  }

  private async onFilesChanged(): Promise<void> {
    // 一次保存会触发好几条事件（problem.json + submissions.json + 目录），
    // 攒一小会儿再刷新，省得同一份数据重算四五遍。
    this.scheduleRefresh();
    void this.deps.refreshTests();
  }

  private send(message: unknown): void {
    // webview 可能刚被关掉，postMessage 会 reject——吞掉即可，下一次刷新会补上。
    void this.view?.webview.postMessage(message).then(undefined, () => undefined);
  }

  private setBusy(text: string | null): void {
    this.busy = text;
    this.send({ type: 'busy', text });
  }

  private notify(level: 'info' | 'warn' | 'error', text: string): void {
    this.notice = { level, text };
    this.send({ type: 'notice', level, text });
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const message = raw as Record<string, unknown>;
    const type = typeof message.type === 'string' ? message.type : '';

    try {
      switch (type) {
        case 'ready':
        case 'refresh':
          await this.recompute();
          return;
        case 'selectProblem':
          this.selectedProblemId = asString(message.problemId);
          await this.recompute();
          return;
        case 'selectContest':
          await this.selectContest(asString(message.contestId));
          return;
        case 'judge':
          await this.judge(null);
          return;
        case 'judgeCase':
          await this.judge(asString(message.testId));
          return;
        case 'debug':
          await this.debug(null);
          return;
        case 'debugCase':
          await this.debug(asString(message.testId));
          return;
        case 'openDiff':
          await this.openDiff(asString(message.testId));
          return;
        case 'openCaseFile':
          await this.openCaseFile(asString(message.testId), asString(message.kind));
          return;
        case 'openDataDir':
          await this.openDataDir();
          return;
        case 'openProblemJson':
          await this.openProblemJson();
          return;
        case 'openContestJson':
          await this.openContestJson();
          return;
        case 'setLimits':
          await this.setLimits(asLimits(message.limits));
          return;
        case 'setComparator':
          await this.setComparator(asComparator(message.config), false);
          return;
        case 'pickComparatorFile':
          await this.pickComparatorFile(asString(message.mode));
          return;
        case 'scanTests':
          await this.scanTests();
          return;
        case 'removeTest':
          await this.removeTest(asString(message.testId));
          return;
        case 'moveTest':
          await this.moveTest(asString(message.testId), asStringOrNull(message.subtaskId));
          return;
        case 'addSubtask':
          await this.addSubtask();
          return;
        case 'removeSubtask':
          await this.removeSubtask(asString(message.subtaskId));
          return;
        case 'updateSubtask':
          await this.updateSubtask(asString(message.subtaskId), asSubtaskPatch(message.patch));
          return;
        case 'evenSubtasks':
          await this.evenSubtasks();
          return;
        case 'clearSubtasks':
          await this.clearSubtasks();
          return;
        case 'rejudge':
          await this.rejudge(asString(message.contestant), asString(message.problem));
          return;
        case 'command':
          await this.runCommand(asString(message.command), message.arg);
          return;
        default:
          return;
      }
    } catch (err) {
      const text = firstLine(err);
      this.deps.output.error(`面板操作失败：${text}`);
      this.notify('error', text);
    }
  }

  // ---------- 评测与运行 ----------

  /** 评测当前源码：onlyTestId 为 null 时跑整题。 */
  private async judge(onlyTestId: string | null): Promise<void> {
    const selected = this.lastState?.selected ?? null;
    if (selected === null) {
      this.notify('warn', '先在「题目」里选一道题。');
      return;
    }
    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined || document.uri.scheme !== 'file') {
      this.notify('warn', '请先打开要评测的源码文件。');
      return;
    }
    if (!isJudgeable(document.uri.fsPath)) {
      this.notify('warn', `Verdict 不认识这个后缀：${path.basename(document.uri.fsPath)}`);
      return;
    }

    this.setBusy(onlyTestId === null ? '评测中…' : `运行测试点 ${onlyTestId}…`);
    try {
      const outcome = await this.deps.commands.judgeDocumentInPackage(document, {
        problemRoot: selected.rootDir,
        ...(onlyTestId === null ? {} : { onlyTestIds: [onlyTestId] }),
        onProgress: (stage) => this.setBusy(stage),
      });
      this.reportOutcome(outcome);
    } finally {
      this.setBusy(null);
      await this.recompute();
    }
  }

  private reportOutcome(outcome: JudgeOutcome | null): void {
    if (outcome === null) {
      return;
    }
    switch (outcome.kind) {
      case 'judged': {
        const accepted = outcome.cases.filter((item) => item.verdict === 'AC').length;
        const worst = summarizeVerdict(outcome.cases) ?? 'AC';
        const scope = outcome.partial === true ? '（只跑了一部分点）' : '';
        this.notify(
          accepted === outcome.cases.length ? 'info' : 'warn',
          `${worst} · AC ${accepted}/${outcome.cases.length} · 得分 ${outcome.score}/${outcome.maxScore}` +
            `${scope} · ${outcome.elapsedMs}ms`,
        );
        return;
      }
      case 'compile-failed': {
        const errors = outcome.compile.diagnostics.filter((item) => item.severity === 'error');
        const first = errors[0];
        this.notify(
          'error',
          `编译失败（${errors.length} 个错误）` +
            (first === undefined ? '' : `：${first.file}:${first.line}:${first.column} ${first.message}`),
        );
        return;
      }
      case 'no-compiler':
        this.notify('error', outcome.message);
        return;
      case 'no-tests':
        this.notify('warn', outcome.message ?? '这道题还没有测试点。');
        return;
    }
  }

  private async debug(testId: string | null): Promise<void> {
    const selected = this.lastState?.selected ?? null;
    if (selected === null) {
      this.notify('warn', '先在「题目」里选一道题。');
      return;
    }
    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined || document.uri.scheme !== 'file') {
      this.notify('warn', '请先打开要调试的源码文件。');
      return;
    }
    const first = testId ?? selected.tests[0]?.id ?? null;
    this.setBusy('准备调试…');
    try {
      const result = await startDebug(
        { context: this.deps.context, output: this.deps.output },
        document,
        { problemRoot: selected.rootDir, ...(first === null ? {} : { testId: first }) },
      );
      const failure = debugFailureText(result);
      if (failure !== null) {
        this.notify('error', failure);
        return;
      }
      this.notify('info', first === null ? '已启动调试。' : `已用测试点 ${first} 启动调试。`);
    } finally {
      this.setBusy(null);
    }
  }

  private async openDiff(testId: string): Promise<void> {
    const selected = this.lastState?.selected ?? null;
    if (selected === null || testId === '') {
      return;
    }
    const item = selected.tests.find((test) => test.id === testId);
    await this.deps.caseDocs.openDiff(
      selected.id,
      testId,
      item?.firstDiffLine ?? undefined,
    );
  }

  // ---------- 打开文件 ----------

  private async openCaseFile(testId: string, kind: string): Promise<void> {
    const selected = this.lastState?.selected ?? null;
    if (selected === null) {
      return;
    }
    const test = selected.tests.find((item) => item.id === testId);
    if (test === undefined) {
      return;
    }
    const relative = kind === 'answer' ? test.answer : test.input;
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(selected.dataDir, relative)),
      { preview: false },
    );
  }

  private async openDataDir(): Promise<void> {
    // 数据可能在总库里，也可能还在题目包自己的 data/ 里——面板上显示哪个就打开哪个。
    const selected = this.lastState?.selected ?? null;
    if (selected === null) {
      throw new Error('先在「题目」里选一道题。');
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(selected.dataDir));
  }

  /** 比赛配置读不出来时，给用户一条直达那个 json 的路（多场比赛时打开的是当前这一场）。 */
  private async openContestJson(): Promise<void> {
    const file =
      this.deps.contest.contestFile() ??
      (workspaceRoot() === undefined
        ? null
        : path.join(workspaceRoot() ?? '', VERDICT_DIR, CONTEST_FILE));
    if (file === null) {
      this.notify('warn', '这个窗口没有打开文件夹。');
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  private async openProblemJson(): Promise<void> {
    const root = this.requireRoot();
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(root, PROBLEM_FILE)),
      { preview: false },
    );
  }

  // ---------- 编辑题目包 ----------

  private requireRoot(): string {
    const selected = this.lastState?.selected ?? null;
    if (selected === null) {
      throw new Error('先在「题目」里选一道题。');
    }
    return selected.rootDir;
  }

  /** 读-改-写 problem.json；改完刷新 Testing 树与面板，两边是同一份数据。 */
  private async editProblem(change: (pkg: ProblemPackage) => void): Promise<void> {
    const pkg = await loadProblem(this.requireRoot());
    change(pkg);
    await saveProblem(pkg);
    await this.deps.refreshTests();
    await this.recompute();
  }

  private async setLimits(patch: Partial<Limits>): Promise<void> {
    const issue = validateLimits(patch);
    if (issue !== null) {
      throw new Error(issue);
    }
    await this.editProblem((pkg) => {
      pkg.problem = withLimits(pkg.problem, patch);
    });
    this.notify('info', '限制已保存。');
  }

  private async setComparator(config: ComparatorConfig, pickFile: boolean): Promise<void> {
    let resolved = config;
    if (pickFile || needsFile(config)) {
      const picked = await pickComparatorSource(config.mode);
      if (picked === null) {
        this.notify('warn', '没有选择文件，比较方式没有改动。');
        return;
      }
      resolved = config.mode === 'interactive' ? { ...config, interactor: picked } : { ...config, spj: picked };
    }
    await this.editProblem((pkg) => {
      pkg.problem = withComparator(pkg.problem, resolved);
    });
    this.notify('info', `比较方式已改为 ${resolved.mode}。`);
  }

  /**
   * 面板上点了「选择文件…」。
   *
   * 只把选中的路径回给面板（填进那个还没保存的表单），不动 problem.json——
   * 用户可能只是想看看，改不改由他按「保存」决定。
   */
  private async pickComparatorFile(mode: string): Promise<void> {
    const picked = await pickComparatorSource(mode);
    if (picked === null) {
      return;
    }
    this.send({
      type: 'filePicked',
      key: mode === 'interactive' ? 'interactor' : 'spj',
      path: picked,
    });
  }

  private async scanTests(): Promise<void> {
    const pkg = await loadProblem(this.requireRoot());
    const plan = await planAddTests(pkg);
    if (plan.added.length === 0) {
      this.notify('info', 'data/ 里的数据都已经登记过了。');
      return;
    }
    pkg.problem.tests = plan.tests;
    await saveProblem(pkg);
    await this.deps.refreshTests();
    await this.recompute();
    this.notify('info', `已登记 ${plan.added.length} 个测试点：${plan.added.map((item) => item.id).join('、')}`);
  }

  private async removeTest(testId: string): Promise<void> {
    const picked = await vscode.window.showWarningMessage(
      `Verdict：把测试点 ${testId} 移出登记？data/ 里的文件会保留。`,
      { modal: true },
      '移出',
    );
    if (picked !== '移出') {
      return;
    }
    await this.editProblem((pkg) => {
      pkg.problem = removeTest(pkg.problem, testId);
    });
    this.notify('info', `测试点 ${testId} 已移出登记（文件还在 data/）。`);
  }

  private async moveTest(testId: string, subtaskId: string | null): Promise<void> {
    await this.editProblem((pkg) => {
      pkg.problem = setTestSubtask(pkg.problem, testId, subtaskId);
    });
    await this.recompute();
  }

  private async addSubtask(): Promise<void> {
    const selected = this.lastState?.selected ?? null;
    if (selected === null) {
      return;
    }
    const used = selected.subtasks.reduce((sum, item) => sum + item.points, 0);
    const suggested = Math.max(0, 100 - used);
    const text = await vscode.window.showInputBox({
      title: 'Verdict：新子任务的分值',
      value: String(suggested),
      validateInput: (value) =>
        Number.isInteger(Number(value)) && Number(value) >= 0 ? undefined : '请填一个非负整数',
    });
    if (text === undefined) {
      return;
    }
    await this.editProblem((pkg) => {
      pkg.problem = addSubtask(pkg.problem, Number(text));
    });
    this.notify('info', '已加一个子任务，它会先认领一个还没归属的测试点。');
  }

  private async removeSubtask(subtaskId: string): Promise<void> {
    await this.editProblem((pkg) => {
      pkg.problem = removeSubtask(pkg.problem, subtaskId);
    });
    this.notify('info', `子任务 ${subtaskId} 已删除，它名下的测试点保留并改为直接计分。`);
  }

  private async updateSubtask(subtaskId: string, patch: SubtaskPatch): Promise<void> {
    await this.editProblem((pkg) => {
      pkg.problem = updateSubtask(pkg.problem, subtaskId, patch);
    });
    this.notify('info', `子任务 ${subtaskId} 已更新。`);
  }

  private async evenSubtasks(): Promise<void> {
    const selected = this.lastState?.selected ?? null;
    if (selected === null || selected.tests.length === 0) {
      this.notify('warn', '先导入测试点再分子任务。');
      return;
    }
    const text = await vscode.window.showInputBox({
      title: 'Verdict：分成几个子任务',
      value: String(Math.min(2, selected.tests.length)),
      validateInput: (value) => {
        const count = Number(value);
        return Number.isInteger(count) && count >= 1 && count <= selected.tests.length
          ? undefined
          : `请填 1 到 ${selected.tests.length} 之间的整数`;
      },
    });
    if (text === undefined) {
      return;
    }
    await this.editProblem((pkg) => {
      const plan = evenSubtasks(pkg.problem.tests, Number(text));
      pkg.problem.subtasks = plan.subtasks;
      pkg.problem.tests = plan.tests;
    });
    this.notify('info', `已按测试点均分成 ${text} 组（组内全对才给分）。`);
  }

  private async clearSubtasks(): Promise<void> {
    const picked = await vscode.window.showWarningMessage(
      'Verdict：清空所有子任务？所有测试点会改为直接计入总分。',
      { modal: true },
      '清空',
    );
    if (picked !== '清空') {
      return;
    }
    await this.editProblem((pkg) => {
      pkg.problem.subtasks = [];
      pkg.problem.tests = clearSubtasks(pkg.problem.tests);
    });
    this.notify('info', '已清空子任务。');
  }

  // ---------- 比赛 ----------

  private async rejudge(contestant: string, problem: string): Promise<void> {
    this.setBusy(`重测 ${contestant} × ${problem}…`);
    try {
      const result = await this.deps.contest.rejudge(contestant, problem);
      this.notify(result.ok ? 'info' : 'warn', result.message);
    } finally {
      this.setBusy(null);
      await this.recompute();
    }
  }

  /** 面板上点按钮走的就是这条：命令白名单 + 可选的一个参数（例如题目 id）。 */
  private async runCommand(command: string, arg?: unknown): Promise<void> {
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`面板不允许执行命令 ${command}`);
    }
    await vscode.commands.executeCommand(command, arg);
    await this.recompute();
  }

  /** 切到另一场比赛：会话记住它，随后面板里的题目、榜单都换成那一场的。 */
  private async selectContest(contestId: string): Promise<void> {
    if (contestId.length === 0) {
      return;
    }
    this.selectedProblemId = null;
    await this.deps.contest.setActive(contestId);
    await this.recompute();
  }

  private standingsState(): PanelStandings | null {
    const summary = this.deps.contest.summary();
    const contest = this.deps.contest.contestData();
    if (summary === null || contest === null) {
      return null;
    }
    const rejudgeOf = new Map(
      summary.submissions.map((item) => [`${item.contestant}\u0000${item.problem}`, item.rejudgeCount]),
    );
    return {
      problems: contest.problems.map((item) => ({ id: item.id, name: item.name })),
      contestants: contest.contestants.map((item) => ({ id: item.id, name: item.name })),
      ranks: summary.standings.ranks,
      cells: summary.standings.cells.map((cell) => ({
        contestant: cell.contestant,
        problem: cell.problem,
        score: cell.score,
        verdict: cell.verdict,
        rejudgeCount: rejudgeOf.get(`${cell.contestant}\u0000${cell.problem}`) ?? 0,
      })),
    };
  }
}

async function pickComparatorSource(mode: string): Promise<string | null> {
  const isInteractor = mode === 'interactive';
  const picked = await vscode.window.showOpenDialog({
    title: isInteractor ? 'Verdict：选择 interactor' : 'Verdict：选择 checker',
    canSelectMany: false,
    filters: isInteractor
      ? { 交互器: ['cpp', 'cc', 'cxx', 'exe', 'out', 'py'], 全部: ['*'] }
      : { 校验器: ['cpp', 'cc', 'cxx', 'exe', 'out', 'py'], 全部: ['*'] },
  });
  return picked?.[0]?.fsPath ?? null;
}

function needsFile(config: ComparatorConfig): boolean {
  if (config.mode === 'spj') {
    return (config.spj ?? '').trim().length === 0;
  }
  if (config.mode === 'interactive') {
    return (config.interactor ?? '').trim().length === 0;
  }
  return false;
}

function watchJsonFiles(onChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    // 题目包、旧版单场比赛的 contest.json / submissions.json，
    // 以及多场比赛的 contests/*.json 与 submissions/*.json 都要盯着。
    '**/{problem.json,contest.json,submissions.json,contests/*.json,submissions/*.json}',
  );
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    watcher.onDidDelete(onChange),
  );
}

function isJudgeable(file: string): boolean {
  return ['.c', '.cc', '.cpp', '.cxx', '.c++', '.py'].includes(path.extname(file).toLowerCase());
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asLimits(value: unknown): Partial<Limits> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const limits: Partial<Limits> = {};
  for (const key of ['timeMs', 'memoryMb', 'stackMb', 'outputKb'] as (keyof Limits)[]) {
    const item = raw[key];
    if (typeof item === 'number') {
      limits[key] = item;
    }
  }
  return limits;
}

function asComparator(value: unknown): ComparatorConfig {
  if (typeof value !== 'object' || value === null) {
    return { mode: 'default' };
  }
  const raw = value as Record<string, unknown>;
  const mode = asString(raw.mode);
  const config: ComparatorConfig = {
    mode:
      mode === 'line' || mode === 'real' || mode === 'spj' || mode === 'interactive'
        ? mode
        : 'default',
  };
  if (typeof raw.absEps === 'number') {
    config.absEps = raw.absEps;
  }
  if (typeof raw.relEps === 'number') {
    config.relEps = raw.relEps;
  }
  if (typeof raw.spj === 'string' && raw.spj.length > 0) {
    config.spj = raw.spj;
  }
  if (typeof raw.interactor === 'string' && raw.interactor.length > 0) {
    config.interactor = raw.interactor;
  }
  return config;
}

function asSubtaskPatch(value: unknown): SubtaskPatch {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const patch: SubtaskPatch = {};
  if (typeof raw.name === 'string') {
    patch.name = raw.name;
  }
  if (typeof raw.points === 'number') {
    patch.points = raw.points;
  }
  if (raw.scoring === 'min' || raw.scoring === 'sum') {
    patch.scoring = raw.scoring;
  }
  if (Array.isArray(raw.dependsOn)) {
    patch.dependsOn = raw.dependsOn.filter((item): item is string => typeof item === 'string');
  }
  return patch;
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}
