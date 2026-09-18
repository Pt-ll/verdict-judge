import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Contest, Contestant, Problem } from '../model';
import { loadProblem } from '../problem/package';
import { SOURCE_EXTENSIONS } from './sources';
import { isFile } from '../../util/files';
import { isInside, toPosixRelative } from '../../util/paths';
import {
  CONTEST_FILE,
  CONTESTS_DIR,
  PROBLEMS_DIR,
  SUBMISSIONS_FILE,
  SUBMISSIONS_DIR,
  VERDICT_DIR,
  contestFileOf,
  contestsDirOf,
  legacyContestFileOf,
  legacySubmissionsFileOf,
  problemDirOf,
  submissionsFileOf,
  verdictDirOf,
} from '../layout';
import {
  ConfigIssues,
  describe,
  isObject,
  messageOf,
  readJsonObject,
  readNonNegative,
  readString,
  readStringArray,
} from '../../util/json';

export {
  CONTEST_FILE,
  CONTESTS_DIR,
  PROBLEMS_DIR,
  SUBMISSIONS_FILE,
  SUBMISSIONS_DIR,
  VERDICT_DIR,
};
/** 选手源码目录：里面每个含源码的子目录都会被自动当成一名选手（见 scanPlayerFolders）。 */
export const PLAYERS_DIR = 'players';
export const CONTEST_JSON_VERSION = 1;

export interface ContestPackage {
  contest: Contest;
  /** 工作区根目录，也就是 .verdict 所在的那一层。 */
  rootDir: string;
  /** .verdict 目录。 */
  verdictDir: string;
  /** 这场比赛自己的配置文件（contests/<id>.json，或是旧的 contest.json）。 */
  file: string;
  /** 这场比赛的评测记录文件（submissions/<id>.json，或是旧的 submissions.json）。 */
  submissionsFile: string;
  /** 题目 id -> 题目包根目录（.verdict/problems/<id>）。 */
  problemDirs: Map<string, string>;
  /**
   * 由 players/ 自动发现、没有写进 contest.json 的选手 id。
   *
   * 记着它只是为了让 saveContest 不把它们写回文件：自动发现是「读的时候顺手算出来」的，
   * 不该因为改了一道题就把它们变成用户配置的一部分。
   */
  autoContestants: string[];
}

/** 工作区里的一场比赛：id 与它落在哪个文件上。 */
export interface ContestRef {
  id: string;
  file: string;
  /** 0.1.2 及更早的 .verdict/contest.json。 */
  legacy: boolean;
}

/** 多场比赛的布局：.verdict/contests/<id>.json。 */
export function contestPath(rootDir: string, contestId: string): string {
  return contestFileOf(rootDir, contestId);
}

/** 0.1.2 及更早的单场比赛布局：.verdict/contest.json。 */
export function legacyContestPath(rootDir: string): string {
  return legacyContestFileOf(rootDir);
}

export function submissionsPath(rootDir: string, contestId: string): string {
  return submissionsFileOf(rootDir, contestId);
}

export function problemDir(rootDir: string, problemId: string): string {
  return problemDirOf(rootDir, problemId);
}

/**
 * 从 startDir 向上找比赛的配置，返回工作区根目录，找不到返回 null。
 *
 * 命中条件是「.verdict/contest.json 存在」或「.verdict/contests/ 目录存在」——
 * 后者是新出来的多场比赛布局，新建比赛时会连目录一起建出来。
 * 与 findProblemRoot 一个思路：从当前文件往上找比让用户填路径可靠；给 stopDir 就只在它里面找。
 */
export async function findContestRoot(
  startDir: string,
  stopDir?: string,
): Promise<string | null> {
  let dir = path.resolve(startDir);
  const stop = stopDir === undefined ? null : path.resolve(stopDir);

  for (;;) {
    if (stop !== null && !isInside(dir, stop)) {
      return null;
    }
    if ((await isFile(legacyContestPath(dir))) || (await isDirectory(contestsDirOf(dir)))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * 列出工作区里的全部比赛。
 *
 * 单场比赛的旧布局（.verdict/contest.json）与多场比赛的新布局（.verdict/contests/*.json）
 * 同时支持：老工作区不用搬家，新工作区想开几场开几场。id 一律以文件名为准
 * （旧布局以文件里的 id 为准），两场比赛重名会当场报错——否则「切到哪一场」是没有答案的。
 */
export async function listContests(rootDir: string): Promise<ContestRef[]> {
  const resolved = path.resolve(rootDir);
  const refs: ContestRef[] = [];

  const legacy = legacyContestPath(resolved);
  if (await isFile(legacy)) {
    refs.push({ id: await readContestId(legacy, path.basename(resolved)), file: legacy, legacy: true });
  }

  for (const name of await readJsonNames(contestsDirOf(resolved))) {
    const file = path.join(contestsDirOf(resolved), name);
    refs.push({ id: name.slice(0, -'.json'.length), file, legacy: false });
  }

  refs.sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));

  const byId = new Map<string, string>();
  for (const ref of refs) {
    const other = byId.get(ref.id);
    if (other !== undefined) {
      throw new Error(
        `两场比赛都叫 "${ref.id}"：\n  ${other}\n  ${ref.file}\n` +
          '比赛 id 决定「榜单、记录、导出」各归各的，重名必须改掉一个。',
      );
    }
    byId.set(ref.id, ref.file);
  }
  return refs;
}

/**
 * 读一场比赛：contest.json 里的题目 id 会被展开成真正的题目包（SPEC §6.1）。
 *
 * 不传 contestId 时用排在最前面的那一场（工作区里只有一场时就是它）。
 */
export async function loadContest(rootDir: string, contestId?: string): Promise<ContestPackage> {
  const resolved = path.resolve(rootDir);
  const refs = await listContests(resolved);
  if (refs.length === 0) {
    throw new Error(
      `没有找到比赛配置：${contestsDirOf(resolved)} 里没有 .json，也没有 ${legacyContestPath(resolved)}`,
    );
  }

  const ref = contestId === undefined ? refs[0] : refs.find((item) => item.id === contestId);
  if (ref === undefined) {
    throw new Error(
      `找不到比赛 "${contestId}"。工作区里有：${refs.map((item) => item.id).join('、')}`,
    );
  }
  return loadContestRef(resolved, ref);
}

async function loadContestRef(resolved: string, ref: ContestRef): Promise<ContestPackage> {
  const verdictDir = verdictDirOf(resolved);
  const file = ref.file;
  const raw = await readJsonObject(file, (target) => fs.promises.readFile(target, 'utf8'));

  const issues = new ConfigIssues();
  const id = ref.id;
  if (!ref.legacy) {
    const declared = readString(raw.id);
    if (declared !== undefined && declared !== id) {
      // 与题目包同一条规矩：文件名的 id 才是身份，里面写另一个名字会让人对不上号。
      issues.add(`比赛 id "${declared}" 与文件名 "${id}.json" 不一致，两边要一致`);
    }
  }
  const title = readString(raw.title) ?? id;

  const maxRejudge = readNonNegative(raw.maxRejudge, 'maxRejudge', issues) ?? 0;
  if (!Number.isInteger(maxRejudge)) {
    issues.add(`maxRejudge 必须是整数，现在是 ${describe(raw.maxRejudge)}`);
  }

  // problems 允许为空：刚建出来的比赛就是这样（先建比赛、再加题）。以前这里当成配置错误，
  // 后果是「新建比赛之后整条比赛链路都打不开」——面板空白，新建题目也加不进比赛。
  const problemIds = readStringArray(raw.problems, 'problems', issues);
  const configured = readContestants(raw.contestants, issues);
  const { problems, problemDirs } = await loadProblems(resolved, problemIds, issues);

  // players/ 下的目录自动算选手：程序放进去就能出现在榜单与整场评测里，不必手写 contestants。
  // contest.json 里显式写过的以它为准（可以自定义显示名与目录）。
  const known = new Set(configured.map((item) => item.id));
  const discovered = (await scanPlayerFolders(resolved)).filter((item) => !known.has(item.id));

  issues.throwIfAny(file);

  return {
    contest: {
      id,
      title,
      problems,
      contestants: [...configured, ...discovered],
      maxRejudge,
      _raw: raw,
    },
    rootDir: resolved,
    verdictDir,
    file,
    submissionsFile: ref.legacy
      ? legacySubmissionsFileOf(resolved)
      : submissionsFileOf(resolved, id),
    problemDirs,
    autoContestants: discovered.map((item) => item.id),
  };
}

/** 只写这场比赛自己的配置文件：题目包、数据与选手源码都不归它管（SPEC §5.8 的同一条规矩）。 */
export async function saveContest(pkg: ContestPackage): Promise<void> {
  // 自动发现的选手不写回文件：它们随时能从 players/ 重新算出来，
  // 写进去只会让「改了一道题」顺带变成一次选手列表的改动。
  const auto = new Set(pkg.autoContestants);
  const contest = {
    ...pkg.contest,
    contestants: pkg.contest.contestants.filter((item) => !auto.has(item.id)),
  };
  const text = `${JSON.stringify(serializeContest(contest), null, 2)}\n`;
  await fs.promises.mkdir(path.dirname(pkg.file), { recursive: true });
  await fs.promises.writeFile(pkg.file, text, 'utf8');
}

/** 新建比赛的落点：总在 contests/ 下，不会去动旧的 contest.json。 */
export function newContestFile(rootDir: string, contestId: string): string {
  return contestFileOf(rootDir, contestId);
}

/** 把一道题加进比赛（题目库是共用的，多场比赛可以同时列出同一道题）。 */
export function addProblemToContest(contest: Contest, problem: Problem): Contest {
  if (contest.problems.some((item) => item.id === problem.id)) {
    return contest;
  }
  return { ...contest, problems: [...contest.problems, problem] };
}

/** 把一道题从比赛里摘掉。题目包与数据都留着，只是这场比赛不再考它。 */
export function removeProblemFromContest(contest: Contest, problemId: string): Contest {
  const problems = contest.problems.filter((item) => item.id !== problemId);
  return problems.length === contest.problems.length ? contest : { ...contest, problems };
}

function readContestants(raw: unknown, issues: ConfigIssues): Contestant[] {
  if (raw === undefined) {
    // 不写也合法：players/ 下的目录会被自动当成选手（见 scanPlayerFolders）。
    return [];
  }
  if (!Array.isArray(raw)) {
    issues.add(`contestants 必须是数组，现在是 ${describe(raw)}`);
    return [];
  }

  const contestants: Contestant[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `contestants[${index}]`;
    if (!isObject(item)) {
      issues.add(`${where} 必须是对象，现在是 ${describe(item)}`);
      return;
    }
    const id = readString(item.id);
    if (id === undefined) {
      issues.add(`${where} 缺少 id`);
      return;
    }
    if (seen.has(id)) {
      issues.add(`选手 id "${id}" 重复了`);
      return;
    }
    seen.add(id);

    const folder = readString(item.folder);
    if (folder === undefined) {
      issues.add(`${where}（选手 ${id}）缺少 folder，例如 "players/${id}"`);
      return;
    }
    contestants.push({ id, name: readString(item.name) ?? id, folder: toPosixRelative(folder) });
  });
  return contestants;
}

async function loadProblems(
  rootDir: string,
  ids: string[],
  issues: ConfigIssues,
): Promise<{ problems: Problem[]; problemDirs: Map<string, string> }> {
  const problems: Problem[] = [];
  const problemDirs = new Map<string, string>();
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      issues.add(`problems 里题目 id "${id}" 重复了`);
      continue;
    }
    seen.add(id);

    try {
      const pkg = await loadProblem(problemDir(rootDir, id));
      if (pkg.problem.id !== id) {
        // 不一致会让榜单、导出 HTML 与目录对不上号，属于必须当场纠正的配置错误。
        issues.add(
          `题目 "${id}" 的 problem.json 里写的是 id "${pkg.problem.id}"，两边要一致`,
        );
        continue;
      }
      problems.push(pkg.problem);
      problemDirs.set(id, pkg.rootDir);
    } catch (err) {
      // 题目包自己的报错很长（一次列全部问题），这里只留第一行并点出文件位置，
      // 用户打开那个 problem.json 就能看到完整清单。
      const first = messageOf(err).split('\n')[0];
      issues.add(`题目 "${id}" 无法加载：${first}`);
    }
  }
  return { problems, problemDirs };
}

/**
 * 扫 players/ 下的一级目录，把「里面有源码的目录」当作选手。
 *
 * 这是「我只把程序放进 players/」这条要求的落点：不必去写 contest.json 的 contestants。
 * id 与显示名都取目录名，顺序按数字感知排序（1、2、10），与显式配置的选手合起来用。
 */
export async function scanPlayerFolders(rootDir: string): Promise<Contestant[]> {
  const dir = path.join(rootDir, PLAYERS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // 没有 players/ 目录不是错误，就是不打算用这条约定。
    return [];
  }

  const found: Contestant[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    // 空目录不算选手：建了个文件夹但还没放程序，不该在榜单上凭空多出一行。
    if (!(await hasSourceFile(path.join(dir, entry.name), 0))) {
      continue;
    }
    found.push({
      id: entry.name,
      name: entry.name,
      folder: toPosixRelative(path.join(PLAYERS_DIR, entry.name)),
    });
  }
  return found.sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
}

/** 目录里（递归，最多 3 层）有没有源码文件。 */
async function hasSourceFile(dir: string, depth: number): Promise<boolean> {
  if (depth > 3) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasSourceFile(target, depth + 1)) {
        return true;
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      return true;
    }
  }
  return false;
}

function serializeContest(contest: Contest): Record<string, unknown> {
  // 与 problem.json 同样的策略：先摊开 _raw 再覆盖已知字段（SPEC §6.5）。
  return {
    ...(contest._raw ?? {}),
    version: CONTEST_JSON_VERSION,
    id: contest.id,
    title: contest.title,
    maxRejudge: contest.maxRejudge,
    problems: contest.problems.map((problem) => problem.id),
    contestants: contest.contestants,
  };
}

/** contests/ 下所有 .json 的文件名；目录不存在就当空（还没有多场比赛而已）。 */
async function readJsonNames(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith('.') &&
        entry.name.toLowerCase().endsWith('.json'),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * 旧布局（.verdict/contest.json）里比赛 id 是写在文件里的，这里读出来当身份。
 *
 * 文件被改坏时退回工作区目录名：调用方随后会走到真正的加载，那里会把 JSON 的错误
 * 完整报出来；这一步只负责给比赛起个能显示的名字。
 */
async function readContestId(file: string, fallback: string): Promise<string> {
  try {
    const raw = await readJsonObject(file, (target) => fs.promises.readFile(target, 'utf8'));
    return readString(raw.id) ?? fallback;
  } catch {
    return fallback;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
