import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findContestRoot, listContests, loadContest, type ContestRef } from '../../core/contest/contest';
import { scoreProblem } from '../../core/judge/score';
import type {
  ComparatorConfig,
  Limits,
  ProblemType,
  SubtaskResult,
  Verdict,
} from '../../core/model';
import { dataFilePath, loadProblem } from '../../core/problem/package';
import { dataRootOf, problemsDirOf } from '../../core/layout';
import type { CaseDocumentStore } from '../caseDocs';
import { activeProblemRoot, discoverProblemRoots, workspaceRoot } from '../workspace';

/** 单个测试点在面板上的样子：登记信息 + 最近一次评测的结论 + 可以展开看的文本。 */
export interface PanelTest {
  id: string;
  input: string;
  answer: string;
  points: number;
  subtask: string | null;
  verdict: Verdict | null;
  timeMs: number | null;
  memoryKb: number | null;
  message: string;
  firstDiffLine: number | null;
  /** 下面三段都是截断后的文本，只够人眼看一眼，不是数据源。 */
  inputText: string;
  expectedText: string;
  outputText: string;
  hasData: boolean;
}

export interface PanelSubtask {
  id: string;
  name: string;
  points: number;
  tests: string[];
  dependsOn: string[];
  scoring: 'min' | 'sum';
  result: SubtaskResult | null;
}

export interface PanelProblemSummary {
  id: string;
  name: string;
  type: ProblemType;
  rootDir: string;
  /** 这道题的测试数据在哪（总库或包内 data/）。 */
  dataDir: string;
  /** 是否在**当前**比赛的题目列表里；多场比赛可以同时用同一道题。 */
  inContest: boolean;
  testCount: number;
  maxScore: number;
  subtaskCount: number;
  /** 题目包读不出来时的原因（problem.json 写坏了）；有它就别再显示别的细节。 */
  broken: string | null;
}

export interface PanelProblemDetail {
  id: string;
  name: string;
  type: ProblemType;
  rootDir: string;
  dataDir: string;
  limits: Limits;
  comparator: ComparatorConfig;
  subtasks: PanelSubtask[];
  tests: PanelTest[];
  /** 不属于任何子任务的测试点 id（它们也计入总分）。 */
  orphanTests: string[];
  score: number;
  maxScore: number;
  /** 结果没覆盖全部测试点（例如只跑了一个点）：分数是下界，不是结论。 */
  partial: boolean;
}

export interface PanelStandings {
  problems: { id: string; name: string }[];
  contestants: { id: string; name: string }[];
  ranks: { contestant: string; rank: number; score: number }[];
  cells: {
    contestant: string;
    problem: string;
    score: number;
    verdict: Verdict | null;
    rejudgeCount: number;
  }[];
}

export interface PanelSource {
  path: string;
  name: string;
  dirty: boolean;
  /** 扩展认识这个后缀（能编译或解释运行），否则「评测」按钮只能是灰的。 */
  judgeable: boolean;
}

export interface PanelState {
  contest: {
    id: string;
    title: string;
    maxRejudge: number;
    /** auto：从 players/ 自动发现（没写进 contest.json）。 */
    contestants: { id: string; name: string; auto: boolean }[];
    problemIds: string[];
    /** 工作区里的全部比赛，供面板顶部切换；至少有一项。 */
    all: { id: string; title: string; legacy: boolean; active: boolean }[];
    /** 题目包与数据的存放位置，面板上直接告诉用户数据在哪。 */
    problemsDir: string;
    dataDir: string;
    /** 读 contest.json 失败的原因；有它时上面几项只是占位。 */
    error: string | null;
  } | null;
  problems: PanelProblemSummary[];
  selected: PanelProblemDetail | null;
  source: PanelSource | null;
  standings: PanelStandings | null;
  busy: string | null;
  notice: { level: 'info' | 'warn' | 'error'; text: string } | null;
}

export interface PanelStateDeps {
  caseDocs: CaseDocumentStore;
  /** 比赛榜单；没有比赛时给 null。 */
  standings: () => PanelStandings | null;
  /** 当前在用的是哪一场比赛。 */
  activeContestId: () => string | null;
}

/** 展开区里最多放这么多字符：面板是给人扫一眼的，不是看全文的地方。 */
const CLIP_CHARS = 4000;

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++', '.py']);

/**
 * 收集面板要展示的全部数据。
 *
 * 每次都从磁盘重读：problem.json / contest.json 随时可能被手改或被 git 换掉，
 * 面板攥着一份可能过期的副本，会让人对着屏幕上的旧分数做决定。
 */
export async function collectPanelState(
  deps: PanelStateDeps,
  selectedProblemId: string | null,
  extras: { busy: string | null; notice: PanelState['notice'] },
): Promise<PanelState> {
  const root = workspaceRoot();
  const refs = await listContestRefs(root);
  const contest = await loadContestSummary(root, refs, deps.activeContestId());
  const roots = await discoverProblemRoots();

  const problems: PanelProblemSummary[] = [];
  for (const dir of roots) {
    problems.push(await summarize(dir, contest?.problemIds ?? []));
  }
  // 比赛里列了、但题目包不在工作区里（比如还没创建）的题也要出现，
  // 否则面板上的题目列表和 contest.json 说的对不上。
  for (const id of contest?.problemIds ?? []) {
    if (!problems.some((item) => item.id === id)) {
      problems.push({
        id,
        name: id,
        type: 'traditional',
        rootDir: '',
        dataDir: '',
        inContest: true,
        testCount: 0,
        maxScore: 0,
        subtaskCount: 0,
        broken: '还没有这个题目包（problem.json 不存在）',
      });
    }
  }

  const selectedId = await pickSelection(selectedProblemId, problems, roots);
  // 单个题目包读不出来（比如正在手改 problem.json）不该让整个面板空白：
  // 详情退化成 null，题目列表与「读不出来」的提示照常显示。
  const selected =
    selectedId === null
      ? null
      : await detail(selectedId, problems, deps.caseDocs).catch(() => null);

  return {
    contest,
    problems,
    selected,
    source: activeSource(),
    standings: deps.standings(),
    busy: extras.busy,
    notice: extras.notice,
  };
}

/** 工作区里的全部比赛；列表本身出错（重名、读不出来）时返回空，具体错误由下面的加载报。 */
async function listContestRefs(root: string | undefined): Promise<ContestRef[]> {
  if (root === undefined) {
    return [];
  }
  const contestRoot = await findContestRoot(root, root);
  if (contestRoot === null) {
    return [];
  }
  try {
    return await listContests(contestRoot);
  } catch {
    return [];
  }
}

async function loadContestSummary(
  root: string | undefined,
  refs: ContestRef[],
  activeId: string | null,
): Promise<PanelState['contest']> {
  if (root === undefined) {
    return null;
  }
  const contestRoot = await findContestRoot(root, root);
  if (contestRoot === null) {
    return null;
  }
  const active = refs.find((item) => item.id === activeId) ?? refs[0];
  try {
    const pkg = await loadContest(contestRoot, active?.id);
    const auto = new Set(pkg.autoContestants);
    return {
      id: pkg.contest.id,
      title: pkg.contest.title,
      maxRejudge: pkg.contest.maxRejudge,
      contestants: pkg.contest.contestants.map((item) => ({
        id: item.id,
        name: item.name,
        auto: auto.has(item.id),
      })),
      problemIds: pkg.contest.problems.map((item) => item.id),
      all: await Promise.all(
        refs.map(async (ref) => ({
          id: ref.id,
          title: ref.id === pkg.contest.id ? pkg.contest.title : await titleOf(contestRoot, ref),
          legacy: ref.legacy,
          active: ref.id === pkg.contest.id,
        })),
      ),
      problemsDir: problemsDirOf(contestRoot),
      dataDir: dataRootOf(contestRoot),
      error: null,
    };
  } catch (err) {
    // 读不出来时把原因带到面板上。以前这里静默返回 null，面板看起来就是「没有比赛」，
    // 用户根本不知道是 contest.json 有问题——这正是「创建比赛后一直不显示」的现场。
    return {
      id: contestRoot,
      title: '比赛配置读不出来',
      maxRejudge: 0,
      contestants: [],
      problemIds: [],
      all: refs.map((ref) => ({
        id: ref.id,
        title: ref.id,
        legacy: ref.legacy,
        active: ref.id === activeId,
      })),
      problemsDir: problemsDirOf(contestRoot),
      dataDir: dataRootOf(contestRoot),
      error: firstLine(err),
    };
  }
}

/** 比赛下拉框里那一行显示的标题：读不出来就退回 id，别为了显示名字把面板整块弄挂。 */
async function titleOf(contestRoot: string, ref: ContestRef): Promise<string> {
  try {
    return (await loadContest(contestRoot, ref.id)).contest.title;
  } catch {
    return ref.id;
  }
}

async function summarize(dir: string, contestProblems: string[]): Promise<PanelProblemSummary> {
  try {
    const pkg = await loadProblem(dir);
    return {
      id: pkg.problem.id,
      name: pkg.problem.name,
      type: pkg.problem.type,
      rootDir: pkg.rootDir,
      dataDir: pkg.dataDir,
      inContest: contestProblems.includes(pkg.problem.id),
      testCount: pkg.problem.tests.length,
      maxScore: scoreProblem(pkg.problem, []).maxScore,
      subtaskCount: pkg.problem.subtasks.length,
      broken: null,
    };
  } catch (err) {
    return {
      id: path.basename(dir),
      name: path.basename(dir),
      type: 'traditional',
      rootDir: dir,
      dataDir: '',
      inContest: contestProblems.includes(path.basename(dir)),
      testCount: 0,
      maxScore: 0,
      subtaskCount: 0,
      broken: firstLine(err),
    };
  }
}

/**
 * 当前该展示哪道题：面板里选中的 > 当前文件所属的 > 第一道。
 *
 * 「选中」排在前面是因为那是用户刚做过的动作；「当前文件」可能只是他切过去看了一眼。
 */
async function pickSelection(
  selectedProblemId: string | null,
  problems: PanelProblemSummary[],
  roots: string[],
): Promise<string | null> {
  if (selectedProblemId !== null && problems.some((item) => item.id === selectedProblemId)) {
    return selectedProblemId;
  }
  const activeRoot = await activeProblemRoot();
  if (activeRoot !== null && roots.includes(activeRoot)) {
    const match = problems.find((item) => item.rootDir === activeRoot);
    if (match !== undefined) {
      return match.id;
    }
  }
  return problems[0]?.id ?? null;
}

async function detail(
  problemId: string,
  problems: PanelProblemSummary[],
  caseDocs: CaseDocumentStore,
): Promise<PanelProblemDetail | null> {
  const summary = problems.find((item) => item.id === problemId);
  if (summary === undefined || summary.rootDir.length === 0 || summary.broken !== null) {
    return null;
  }
  const pkg = await loadProblem(summary.rootDir);
  const results = caseDocs.casesOf(pkg.problem.id);
  const byTest = new Map(results.map((item) => [item.test, item]));
  const scored = scoreProblem(pkg.problem, results);
  const subtaskResult = new Map(scored.subtasks.map((item) => [item.id, item]));

  const tests: PanelTest[] = [];
  for (const test of pkg.problem.tests) {
    const result = byTest.get(test.id);
    tests.push({
      id: test.id,
      input: test.input,
      answer: test.answer,
      points: test.points ?? 1,
      subtask: test.subtask ?? null,
      verdict: result?.verdict ?? null,
      timeMs: result?.timeMs ?? null,
      memoryKb: result?.memoryKb ?? null,
      message: result?.message ?? '',
      firstDiffLine: result?.firstDiffLine ?? null,
      inputText: await clipFile(dataFilePath(pkg, test.input)),
      expectedText:
        result === undefined ? await clipFile(dataFilePath(pkg, test.answer)) : clip(result.answer),
      outputText: result === undefined ? '' : clip(result.output),
      hasData: await exists(dataFilePath(pkg, test.input)),
    });
  }

  const covered = new Set(results.map((item) => item.test));
  return {
    id: pkg.problem.id,
    name: pkg.problem.name,
    type: pkg.problem.type,
    rootDir: pkg.rootDir,
    dataDir: pkg.dataDir,
    limits: pkg.problem.limits,
    comparator: pkg.problem.comparator,
    subtasks: pkg.problem.subtasks.map((item) => ({
      id: item.id,
      name: item.name ?? `子任务 ${item.id}`,
      points: item.points,
      tests: [...item.tests],
      dependsOn: [...item.dependsOn],
      scoring: item.scoring,
      result: subtaskResult.get(item.id) ?? null,
    })),
    tests,
    orphanTests: tests
      .filter((test) => !pkg.problem.subtasks.some((item) => item.tests.includes(test.id)))
      .map((test) => test.id),
    score: scored.score,
    maxScore: scored.maxScore,
    partial: results.length > 0 && pkg.problem.tests.some((test) => !covered.has(test.id)),
  };
}

function activeSource(): PanelSource | null {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined || document.uri.scheme !== 'file') {
    return null;
  }
  const file = document.uri.fsPath;
  return {
    path: file,
    name: path.basename(file),
    dirty: document.isDirty,
    judgeable: SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  };
}

async function clipFile(target: string): Promise<string> {
  try {
    return clip(await fs.promises.readFile(target));
  } catch {
    return '';
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isFile();
  } catch {
    return false;
  }
}

function clip(bytes: Buffer): string {
  const text = bytes.toString('utf8').replace(/\r\n?/g, '\n');
  return text.length > CLIP_CHARS ? `${text.slice(0, CLIP_CHARS)}\n…（已截断）` : text;
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}
