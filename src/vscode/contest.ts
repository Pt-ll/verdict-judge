import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addContestantToContest,
  PLAYERS_DIR,
  VERDICT_DIR,
  contestPath,
  declarePlayers,
  ensureContestantFolder,
  listContests,
  loadContest,
  newContestFile,
  problemDir,
  removeContestantFromContest,
  saveContest,
  submissionsPath,
  type ContestRef,
  type ContestPackage,
} from '../core/contest/contest';
import { loadSubmissions, mergeSubmissions, saveSubmissions } from '../core/contest/submissions';
import { canRejudge, computeStandings, summaryStats } from '../core/contest/standings';
import { PROBLEM_FILE, saveProblem } from '../core/problem/package';
import { standingsToHtml, type ReportOptions } from '../core/report/html';
import {
  DATA_DIR,
  ensureWorkspaceLayout,
  playersFileOf,
} from '../core/layout';
import { toPosixRelative } from '../util/paths';
import {
  type Contest,
  type Contestant,
  DEFAULT_LIMITS,
  type ContestStats,
  type Problem,
  type Standings,
  type Submission,
} from '../core/model';
import { judgeContest, rejudgeSubmission } from '../engineFacade';
import { readEngineOptions } from './config';
import type { VerdictOutput } from './output';
import type { VerdictStatusBar } from './statusBar';
import { showStandingsView } from './standingsView';
import { workspaceRoot } from './workspace';

export const COMMAND_NEW_CONTEST = 'verdict.newContest';
export const COMMAND_SWITCH_CONTEST = 'verdict.switchContest';
export const COMMAND_NEW_PROBLEM = 'verdict.newProblem';
export const COMMAND_ADD_CONTESTANT = 'verdict.addContestantToContest';
export const COMMAND_REMOVE_CONTESTANT = 'verdict.removeContestantFromContest';
export const COMMAND_NEW_CONTESTANT = 'verdict.newContestant';
export const COMMAND_JUDGE_ALL = 'verdict.judgeAll';
export const COMMAND_REJUDGE = 'verdict.rejudge';
export const COMMAND_SHOW_STANDINGS = 'verdict.showStandings';
export const COMMAND_EXPORT_HTML = 'verdict.exportHtml';

export interface ContestDeps {
  context: vscode.ExtensionContext;
  output: VerdictOutput;
  status: VerdictStatusBar;
}

export interface ContestSummary {
  contestId: string;
  title: string;
  submissions: Submission[];
  /** 找不到源码的格子（还没交）。 */
  missing: { contestant: string; problem: string }[];
  standings: Standings;
  stats: ContestStats;
  cancelled: boolean;
}

export interface RejudgeResult {
  ok: boolean;
  message: string;
  submission?: Submission;
}

/** 记住「当前在用哪一场比赛」的 workspaceState 键。 */
const ACTIVE_CONTEST_KEY = 'verdict.activeContest';

/**
 * 一场比赛的操作入口。
 *
 * 状态不长期攥在内存里：题目包、选手源码、提交记录都可能在编辑器外面被改
 * （git 切分支、手改 json），所以每次操作前重读一遍。代价是几个小文件，
 * 换来的是「看到的就是磁盘上的」。
 */
export class ContestSession {
  private pkg: ContestPackage | null = null;
  private submissions: Submission[] = [];
  private missing: { contestant: string; problem: string }[] = [];
  private loaded = false;
  /**
   * 当前在用的是哪一场比赛（工作区里可以同时存在好几场，SPEC §6.2）。
   *
   * 选中的那一场记在 workspaceState 里：编辑器重开之后还是同一场，
   * 否则每次重启都会悄悄换成排序最靠前的那场，出题人会在错的地方改配置。
   */
  private active: string | null = null;
  private restored = false;

  constructor(private readonly deps: ContestDeps) {}

  /** 工作区里的全部比赛；没有工作区或一场都没有时是空数组。 */
  async refs(): Promise<ContestRef[]> {
    const root = workspaceRoot();
    return root === undefined ? [] : listContests(root);
  }

  /** 当前比赛的 id；还没加载过时为 null。 */
  activeId(): string | null {
    return this.active;
  }

  /** 当前比赛的配置文件路径（面板上「打开比赛配置」用它）。 */
  contestFile(): string | null {
    return this.pkg?.file ?? null;
  }

  /** 切到另一场比赛。不存在的 id 会退回默认的那场（load 里兜底）。 */
  async setActive(contestId: string): Promise<void> {
    this.active = contestId;
    this.loaded = false;
    await this.load(true);
  }

  async load(force = false): Promise<ContestPackage | null> {
    if (this.loaded && !force && this.pkg !== null) {
      return this.pkg;
    }
    this.loaded = true;

    const root = workspaceRoot();
    if (root === undefined) {
      return this.reset();
    }
    const refs = await this.refs();
    if (refs.length === 0) {
      return this.reset();
    }

    const wanted = this.active ?? this.restoredActive();
    const ref = refs.find((item) => item.id === wanted) ?? refs[0];
    if (ref === undefined) {
      return this.reset();
    }

    this.pkg = await loadContest(root, ref.id);
    this.active = ref.id;
    await this.rememberActive(ref.id);
    this.submissions = await loadSubmissions(this.pkg.submissionsFile);
    return this.pkg;
  }

  private reset(): null {
    this.pkg = null;
    this.submissions = [];
    this.missing = [];
    return null;
  }

  /** 上一次用过的比赛 id；存在 workspaceState 里，跟着工作区走。 */
  private restoredActive(): string | null {
    if (!this.restored) {
      this.restored = true;
      const stored = this.deps.context.workspaceState.get<string>(ACTIVE_CONTEST_KEY);
      if (typeof stored === 'string' && stored.length > 0) {
        this.active = stored;
      }
    }
    return this.active;
  }

  private async rememberActive(contestId: string): Promise<void> {
    if (this.deps.context.workspaceState.get<string>(ACTIVE_CONTEST_KEY) === contestId) {
      return;
    }
    await this.deps.context.workspaceState.update(ACTIVE_CONTEST_KEY, contestId);
  }

  summary(cancelled = false): ContestSummary | null {
    if (this.pkg === null) {
      return null;
    }
    return {
      contestId: this.pkg.contest.id,
      title: this.pkg.contest.title,
      submissions: this.submissions,
      missing: this.missing,
      standings: computeStandings(this.pkg.contest, this.submissions),
      stats: summaryStats(this.pkg.contest, this.submissions),
      cancelled,
    };
  }

  /**
   * 评测整场：选手 × 题目。每跑完一条就落盘，中途取消不丢已完成的。
   *
   * 注意副作用：整场评测会把每个格子的提交换成新记录，重测计数因此归零。
   * 重测上限约束的是「针对单条提交的重测」，不是「整场重跑」——
   * 后者是出题人主动重新判一遍，属于另一件事。
   */
  async judgeAll(token?: vscode.CancellationToken): Promise<ContestSummary | null> {
    const pkg = await this.load();
    if (pkg === null) {
      void vscode.window.showWarningMessage(
        'Verdict：这个工作区里没有比赛。先执行「Verdict: 新建比赛」。',
      );
      return null;
    }

    const { output, status } = this.deps;
    const total = pkg.contest.contestants.length * pkg.contest.problems.length;
    let done = 0;
    status.setBusy('评测准备中');
    output.info(
      `开始评测「${pkg.contest.title}」：` +
        `${String(pkg.contest.contestants.length)} 名选手 × ${String(pkg.contest.problems.length)} 道题`,
    );

    try {
      const result = await judgeContest(pkg, readEngineOptions(this.deps.context), token, {
        onProgress: (stage) => {
          status.setBusy(`评测 ${String(Math.min(done + 1, total))}/${String(total)}`);
          output.debug(stage);
        },
        onSubmission: async (submission) => {
          done += 1;
          this.submissions = mergeSubmissions(this.submissions, [submission]);
          await saveSubmissions(pkg.submissionsFile, this.submissions);
          const accepted = this.submissions.filter((item) => item.verdict === 'AC').length;
          status.setBusy(`评测 ${String(done)}/${String(total)} · AC ${String(accepted)}`);
        },
      });

      this.missing = result.missing;
      for (const item of result.missing) {
        output.info(`跳过（没有源码）：${item.contestant} × ${item.problem}`);
      }

      const summary = this.summary(result.cancelled);
      if (summary !== null) {
        output.info(
          `评测结束：${String(summary.submissions.length)} 份提交，` +
            `最高 ${String(summary.stats.highest)} 分，平均 ${String(summary.stats.average)} 分`,
        );
        status.setIdle(
          `$(beaker) ${pkg.contest.id}`,
          `Verdict：${summary.title} · ${String(summary.submissions.length)} 份提交`,
        );
      }
      return summary;
    } catch (err) {
      status.setWarning('Verdict：评测失败');
      throw err;
    }
  }

  /** 当前加载到的比赛配置；没有比赛时为 null。面板要用它拼榜单。 */
  contestData(): Contest | null {
    return this.pkg?.contest ?? null;
  }

  /** 重测一条提交；受 maxRejudge 约束（SPEC §5.7）。 */
  async rejudge(
    contestant: string,
    problem: string,
    token?: vscode.CancellationToken,
  ): Promise<RejudgeResult> {
    const pkg = await this.load();
    if (pkg === null) {
      return { ok: false, message: '这个工作区里没有比赛。' };
    }

    const submission = this.submissions.find(
      (item) => item.contestant === contestant && item.problem === problem,
    );
    if (submission === undefined) {
      return { ok: false, message: `找不到 ${contestant} 在 ${problem} 题的提交。` };
    }
    if (!canRejudge(submission, pkg.contest)) {
      return {
        ok: false,
        message:
          `${contestant} 在 ${problem} 题已经重测 ${String(submission.rejudgeCount)} 次，` +
          `到达上限（${String(pkg.contest.maxRejudge)} 次）后不能再重测。`,
      };
    }

    const updated = await rejudgeSubmission(
      submission,
      pkg,
      readEngineOptions(this.deps.context),
      token,
      (stage) => this.deps.output.debug(stage),
    );
    this.submissions = mergeSubmissions(this.submissions, [updated]);
    await saveSubmissions(pkg.submissionsFile, this.submissions);
    return {
      ok: true,
      message: `已重测：${contestant} 的 ${problem} 题（第 ${String(updated.rejudgeCount)} 次）。`,
      submission: updated,
    };
  }

  html(options: ReportOptions = { theme: 'ioi', embedData: true }): string | null {
    const summary = this.summary();
    if (this.pkg === null || summary === null) {
      return null;
    }
    return standingsToHtml(this.pkg.contest, summary.standings, options, this.submissions);
  }

  /** 导出榜单 HTML；给了 target 就直接写那里（集成测试用），否则弹保存对话框。 */
  async exportHtml(target?: string): Promise<string | null> {
    const pkg = await this.load();
    const html = this.html();
    if (pkg === null || html === null) {
      void vscode.window.showWarningMessage('Verdict：这个工作区里没有比赛。');
      return null;
    }

    let destination = target;
    if (destination === undefined) {
      const picked = await vscode.window.showSaveDialog({
        title: 'Verdict：导出榜单 HTML',
        defaultUri: vscode.Uri.file(
          path.join(pkg.verdictDir, 'report', `${pkg.contest.id}-standings.html`),
        ),
        filters: { HTML: ['html'] },
      });
      if (picked === undefined) {
        return null;
      }
      destination = picked.fsPath;
    }

    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, html, 'utf8');
    this.deps.output.info(`已导出榜单：${destination}`);

    if (target === undefined) {
      const choice = await vscode.window.showInformationMessage(
        `Verdict：榜单已导出到 ${destination}`,
        '在浏览器中打开',
      );
      if (choice === '在浏览器中打开') {
        // 自包含 HTML，用系统浏览器打开即可（不走网络）。
        await vscode.env.openExternal(vscode.Uri.file(destination));
      }
    }
    return destination;
  }

  async showStandings(): Promise<void> {
    const pkg = await this.load();
    const summary = this.summary();
    if (pkg === null || summary === null) {
      void vscode.window.showWarningMessage(
        'Verdict：这个工作区里没有比赛。先执行「Verdict: 新建比赛」。',
      );
      return;
    }

    showStandingsView(this.deps.context, {
      title: pkg.contest.title,
      contestId: pkg.contest.id,
      maxRejudge: pkg.contest.maxRejudge,
      contestants: pkg.contest.contestants.map((item) => ({ id: item.id, name: item.name })),
      problems: pkg.contest.problems.map((item) => ({ id: item.id, name: item.name })),
      standings: summary.standings,
      stats: summary.stats,
      submissions: this.submissions,
    });
  }
}

export interface ContestCommands {
  disposables: vscode.Disposable[];
  session: ContestSession;
}

export function registerContestCommands(deps: ContestDeps): ContestCommands {
  const session = new ContestSession(deps);
  return {
    session,
    disposables: [
      vscode.commands.registerCommand(COMMAND_NEW_CONTEST, () => createContest(deps, session)),
      vscode.commands.registerCommand(COMMAND_SWITCH_CONTEST, () => switchContest(session)),
      vscode.commands.registerCommand(COMMAND_NEW_PROBLEM, () => createProblem(deps, session)),
      vscode.commands.registerCommand(COMMAND_ADD_CONTESTANT, (arg?: unknown) =>
        addContestant(deps, session, asId(arg)),
      ),
      vscode.commands.registerCommand(COMMAND_NEW_CONTESTANT, () =>
        createContestant(deps, session),
      ),
      vscode.commands.registerCommand(COMMAND_REMOVE_CONTESTANT, (arg?: unknown) =>
        removeContestant(deps, session, asId(arg)),
      ),
      vscode.commands.registerCommand(COMMAND_JUDGE_ALL, () =>
        withProgress('Verdict：评测全部', (token) => session.judgeAll(token)),
      ),
      vscode.commands.registerCommand(COMMAND_REJUDGE, () => pickAndRejudge(deps, session)),
      vscode.commands.registerCommand(COMMAND_SHOW_STANDINGS, () => session.showStandings()),
      vscode.commands.registerCommand(COMMAND_EXPORT_HTML, () => session.exportHtml()),
    ],
  };
}

async function withProgress<T>(
  title: string,
  run: (token: vscode.CancellationToken) => Promise<T>,
): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => run(token),
  );
}

/** 重测：列出有提交的格子，让用户挑一个（没有提交就没得重测）。 */
async function pickAndRejudge(deps: ContestDeps, session: ContestSession): Promise<void> {
  const summary = (await session.load()) === null ? null : session.summary();
  if (summary === null) {
    void vscode.window.showWarningMessage('Verdict：这个工作区里没有比赛。');
    return;
  }
  if (summary.submissions.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：还没有评测结果。先执行「Verdict: 评测全部」。',
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    summary.submissions.map((item) => ({
      label: `${item.contestant} × ${item.problem}`,
      description: `${item.verdict ?? '?'} ${String(item.result?.score ?? 0)}/${String(item.result?.maxScore ?? 0)}`,
      detail: `已重测 ${String(item.rejudgeCount)} 次`,
      submission: item,
    })),
    { title: 'Verdict：重测哪一条提交' },
  );
  if (picked === undefined) {
    return;
  }

  const result = await withProgress('Verdict：重测', (token) =>
    session.rejudge(picked.submission.contestant, picked.submission.problem, token),
  );
  deps.output.info(result.message);
  if (result.ok) {
    void vscode.window.showInformationMessage(`Verdict：${result.message}`);
  } else {
    void vscode.window.showWarningMessage(`Verdict：${result.message}`);
  }
}

/**
 * 让一位选手参加当前比赛。
 *
 * 选手池是工作区级的（`players/` 目录 + `.verdict/players.json`），比赛只记 id 名单 ——
 * 和题目一模一样：可选的东西是共用的，「这场谁上」是每场比赛自己的事。
 */
async function addContestant(
  deps: ContestDeps,
  session: ContestSession,
  contestantId: string | null,
): Promise<void> {
  const pkg = await session.load();
  if (pkg === null) {
    void vscode.window.showWarningMessage(
      'Verdict：这个工作区里还没有比赛。先执行「Verdict: 新建比赛」。',
    );
    return;
  }
  if (pkg.pool.length === 0) {
    void vscode.window.showWarningMessage(
      `Verdict：选手池是空的。把源码放进 ${path.join(pkg.rootDir, PLAYERS_DIR, '<名字>')}，` +
        `或在 ${playersFileOf(pkg.rootDir)} 里声明选手。`,
    );
    return;
  }

  const inContest = new Set(pkg.contest.contestants.map((item) => item.id));
  const candidates = pkg.pool.filter((item) => !inContest.has(item.id));
  // 从面板点进来的带着 id；从命令面板进来的没带，列出还能加的人让他挑。
  const picked =
    contestantId === null
      ? await pickContestant(candidates.length > 0 ? candidates : pkg.pool, '让谁参加这场比赛')
      : pkg.pool.find((item) => item.id === contestantId);
  if (picked === undefined) {
    return;
  }
  if (inContest.has(picked.id)) {
    deps.output.info(`${picked.name} 已经在这场比赛里了。`);
    return;
  }

  // 第一次加这个人：把源码目录建出来，他接着就能把 A.cpp 丢进去。
  const folder = await ensureContestantFolder(pkg.rootDir, picked);
  pkg.contest = addContestantToContest(pkg.contest, picked);
  await saveContest(pkg);
  // 存完重读一遍：名单从「默认全上」变成「显式名单」这件事只有读完才知道。
  await session.load(true);
  deps.output.info(
    `已让 ${picked.name} 参加比赛「${pkg.contest.title}」。源码目录：${folder}`,
  );
  void vscode.window.showInformationMessage(
    `Verdict：${picked.name} 已加入「${pkg.contest.title}」，源码放在 ${folder} 下。`,
  );
}

/**
 * 新建一位选手：建好 `players/<id>/`（第一次连 `players/` 一起建），
 * 名字和 id 不一样时把声明写进 `.verdict/players.json`，有比赛就顺手让他参加当前这场。
 *
 * 这是「选手池还是空的时候」唯一的出路——不然用户得先猜出目录约定、自己去建文件夹。
 */
async function createContestant(deps: ContestDeps, session: ContestSession): Promise<void> {
  const root = workspaceRoot();
  if (root === undefined) {
    void vscode.window.showWarningMessage('Verdict：请先打开一个文件夹作为工作区。');
    return;
  }

  const id = await askInput('选手 id（也是目录名与源码文件名，例如 alice）', '', (value) =>
    isIdentifier(value) ? undefined : '只能用字母、数字、下划线或短横线',
  );
  if (id === undefined) {
    return;
  }
  const name = ((await askInput('显示名（留空就用 id）', id)) ?? id).trim() || id;

  const contestant: Contestant = {
    id,
    name,
    folder: toPosixRelative(path.join(PLAYERS_DIR, id)),
  };
  const folder = await ensureContestantFolder(root, contestant);
  // 只有自定义了显示名才需要声明；否则 players/ 的目录名已经说明一切。
  if (name !== id) {
    await declarePlayers(root, [contestant]);
  }

  const pkg = await session.load(true);
  if (pkg !== null && !pkg.contest.contestants.some((item) => item.id === id)) {
    pkg.contest = addContestantToContest(pkg.contest, contestant);
    await saveContest(pkg);
    await session.load(true);
    deps.output.info(`已把新选手 ${name} 加进比赛「${pkg.contest.title}」。`);
  }

  deps.output.info(`已新建选手 ${name}（${folder}）。把源码放进去即可。`);
  void vscode.window.showInformationMessage(
    `Verdict：已新建选手「${name}」。把 <题目>.cpp 放进 ${folder}。`,
  );
}

/** 让一位选手退出当前比赛：人还在池子里，别的比赛也不受影响。 */
async function removeContestant(
  deps: ContestDeps,
  session: ContestSession,
  contestantId: string | null,
): Promise<void> {
  const pkg = await session.load();
  if (pkg === null) {
    void vscode.window.showWarningMessage('Verdict：这个工作区里还没有比赛。');
    return;
  }
  if (pkg.contest.contestants.length === 0) {
    void vscode.window.showWarningMessage('Verdict：这场比赛里还没有选手。');
    return;
  }

  const picked =
    contestantId === null
      ? await pickContestant(pkg.contest.contestants, '让谁退出这场比赛')
      : pkg.contest.contestants.find((item) => item.id === contestantId);
  if (picked === undefined) {
    return;
  }

  pkg.contest = removeContestantFromContest(pkg.contest, picked.id);
  await saveContest(pkg);
  await session.load(true);
  deps.output.info(
    `已让 ${picked.name} 退出比赛「${pkg.contest.title}」（人还在选手池里）。`,
  );
  void vscode.window.showInformationMessage(
    `Verdict：${picked.name} 已退出「${pkg.contest.title}」，选手池与源码都没动。`,
  );
}

async function pickContestant(
  pool: readonly Contestant[],
  title: string,
): Promise<Contestant | undefined> {
  const picked = await vscode.window.showQuickPick(
    pool.map((item) => ({
      label: item.name,
      description: item.name === item.id ? '' : item.id,
      detail: item.folder,
      contestant: item,
    })),
    { title: `Verdict：${title}` },
  );
  return picked?.contestant;
}

function asId(arg: unknown): string | null {
  return typeof arg === 'string' && arg.length > 0 ? arg : null;
}

/** 切比赛：列出现有的几场让用户挑一个，选完面板与榜单都跟着换。 */
async function switchContest(session: ContestSession): Promise<void> {
  const refs = await session.refs();
  if (refs.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：这个工作区里还没有比赛。先执行「Verdict: 新建比赛」。',
    );
    return;
  }
  if (refs.length === 1) {
    await session.setActive(refs[0]?.id ?? '');
    void vscode.window.showInformationMessage(
      `Verdict：工作区里只有一场比赛（${refs[0]?.id ?? ''}），已经切到它。`,
    );
    return;
  }

  const active = session.activeId();
  const picked = await vscode.window.showQuickPick(
    refs.map((ref) => ({
      label: ref.id,
      description: ref.id === active ? '（当前）' : ref.legacy ? 'contest.json（旧布局）' : '',
      detail: ref.file,
      id: ref.id,
    })),
    { title: 'Verdict：切换到哪一场比赛' },
  );
  if (picked === undefined) {
    return;
  }
  await session.setActive(picked.id);
  void vscode.window.showInformationMessage(`Verdict：已切换到比赛「${picked.id}」。`);
}

async function createContest(deps: ContestDeps, session: ContestSession): Promise<void> {
  const root = workspaceRoot();
  if (root === undefined) {
    void vscode.window.showWarningMessage('Verdict：请先打开一个文件夹作为工作区。');
    return;
  }

  // 一个工作区可以同时放好几场比赛（SPEC §6.2），所以这里只要求 id 不与已有的撞上。
  const existing = await session.refs();
  const taken = new Set(existing.map((ref) => ref.id));
  const id = await askInput('比赛 id（多场比赛各用各的 id）', path.basename(root), (value) =>
    isIdentifier(value) ? undefined : '只能用字母、数字、下划线或短横线',
  );
  if (id === undefined) {
    return;
  }
  if (taken.has(id)) {
    void vscode.window.showWarningMessage(
      `Verdict：已经有一场叫 "${id}" 的比赛了：${contestPath(root, id)}。换一个 id，或用「Verdict: 切换比赛」。`,
    );
    return;
  }
  const title = (await askInput('比赛标题', id)) ?? id;
  const maxRejudgeText = await askInput('最大重测次数', '3', (value) =>
    Number.isInteger(Number(value)) && Number(value) >= 0 ? undefined : '请填一个非负整数',
  );
  if (maxRejudgeText === undefined) {
    return;
  }
  const contestantText =
    (await askInput('选手 id（逗号分隔；留空也行——players/ 下的目录会自动识别）', '')) ?? '';

  const contestants = contestantText
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => ({ id: item, name: item, folder: `players/${item}` }));

  await saveContest({
    contest: {
      id,
      title,
      maxRejudge: Number(maxRejudgeText),
      problems: [],
      contestants,
    },
    rootDir: root,
    verdictDir: path.join(root, VERDICT_DIR),
    file: newContestFile(root, id),
    submissionsFile: submissionsPath(root, id),
    problemDirs: new Map(),
    // 新建时池子还是空的（players/ 要到第一次 loadContest 时才扫），名单是不是显式写的
    // 取决于用户在新建流程里填没填人：填了就是一份名单，没填就是「池子里全上」。
    pool: [],
    contestantsExplicit: contestants.length > 0,
    declaredIds: contestants.map((item) => item.id),
  });
  // 目录一次备齐：`.verdict/{contests,problems,data,submissions}` 与 `players/`。
  // 用户第一次用这个工作区时，最不想干的事就是先手工建目录再回来点按钮。
  await ensureWorkspaceLayout(root);

  await session.setActive(id);

  deps.output.info(`已新建比赛：${contestPath(root, id)}`);
  void vscode.window.showInformationMessage(
    `Verdict：已新建比赛「${title}」。接下来用「Verdict: 新建题目」加题，` +
      `选手源码放在 ${path.join(root, PLAYERS_DIR, '<选手>')} 下。`,
  );
}

async function createProblem(deps: ContestDeps, session: ContestSession): Promise<void> {
  const root = workspaceRoot();
  if (root === undefined) {
    void vscode.window.showWarningMessage('Verdict：请先打开一个文件夹作为工作区。');
    return;
  }

  const id = await askInput('题目 id（例如 A）', 'A', (value) =>
    isIdentifier(value) ? undefined : '只能用字母、数字、下划线或短横线',
  );
  if (id === undefined) {
    return;
  }

  const dir = problemDir(root, id);
  if (fs.existsSync(path.join(dir, PROBLEM_FILE))) {
    void vscode.window.showWarningMessage(`Verdict：题目 ${id} 已经存在：${dir}`);
    return;
  }

  const name = (await askInput('题目名', `${id}. `)) ?? id;
  const timeText = await askInput('时间限制（毫秒）', String(DEFAULT_LIMITS.timeMs), (value) =>
    Number.isInteger(Number(value)) && Number(value) > 0 ? undefined : '请填一个正整数',
  );
  if (timeText === undefined) {
    return;
  }
  const memoryText = await askInput(
    '内存限制（MB）',
    String(DEFAULT_LIMITS.memoryMb),
    (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? undefined : '请填一个正整数'),
  );
  if (memoryText === undefined) {
    return;
  }

  const memoryMb = Number(memoryText);
  // 新建题目顺手把工作区布局补全（.verdict/... 与 players/），老工作区少哪个补哪个。
  await ensureWorkspaceLayout(root);
  // 测试数据统一放进总库（.verdict/data/<题目 id>），多场比赛共用同一道题的数据，
  // 也不用在题目包目录里翻来翻去。
  const dataDir = path.join(root, VERDICT_DIR, DATA_DIR, id);
  const problem: Problem = {
    id,
    name: name.trim().length > 0 ? name : id,
    type: 'traditional',
    // 栈上限跟内存走，与 SPEC §6.3 的示例一致。
    limits: { ...DEFAULT_LIMITS, timeMs: Number(timeText), memoryMb, stackMb: memoryMb },
    comparator: { mode: 'default' },
    subtasks: [],
    tests: [],
  };
  await saveProblem({
    problem,
    rootDir: dir,
    dataDir,
    extraDir: path.join(dir, 'extra'),
  });
  await fs.promises.mkdir(dataDir, { recursive: true });

  // 在比赛工作区里新建的题目，顺手加进题目列表：这是绝大多数情况下的意图，
  // 不想加也可以事后从 contest.json 里删掉。
  const pkg = await session.load();
  if (pkg !== null && !pkg.contest.problems.some((item) => item.id === id)) {
    pkg.contest.problems.push(problem);
    await saveContest(pkg);
    deps.output.info(`已把题目 ${id} 加入比赛「${pkg.contest.title}」`);
  }

  deps.output.info(`已新建题目：${path.join(dir, PROBLEM_FILE)}`);
  void vscode.window.showInformationMessage(
    `Verdict：已新建题目「${problem.name}」。把 1.in / 1.out 放进 ${dataDir}，` +
      '再执行「Verdict: 导入测试点」。',
  );
}

async function askInput(
  title: string,
  value: string,
  validate?: (input: string) => string | undefined,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Verdict：${title}`,
    value,
    ...(validate === undefined ? {} : { validateInput: validate }),
  });
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
