import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Contest, Contestant, Problem } from '../model';
import { loadProblem } from '../problem/package';
import { SOURCE_EXTENSIONS } from './sources';
import { isFile } from '../../util/files';
import { isInside, toNativeRelative, toPosixRelative } from '../../util/paths';
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
  playersFileOf,
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
   * 工作区里**全部**可选选手（0.1.4 的「选手池」，SPEC §6.2）。
   *
   * 来源三处，按优先级合并（先出现的先用它的 name/folder）：
   *   1. `.verdict/players.json` 里显式声明的（可自定义显示名与目录）；
   *   2. 本场比赛文件里旧写法的对象（0.1.3 及更早把声明写在 contestants 里，兼容读）；
   *   3. `players/` 下含源码的目录（自动发现，放进去就算）。
   */
  pool: Contestant[];
  /**
   * 本场比赛的参赛名单是「显式写下来的」还是「默认全上」。
   *
   * 没写 contestants 字段 = 池子里所有人都参加（0.1.2 起的老行为：放进去就算）；
   * 写了（哪怕是空数组）= 只按这份名单来。这一位决定 saveContest 要不要把这个字段写出去。
   */
  contestantsExplicit: boolean;
  /**
   * 池子里哪些人是「被声明过的」（写了自定义显示名或目录：players.json 或比赛文件里的对象写法）。
   *
   * 其余的就是 players/ 下扫出来的——面板上标成「自动发现」，让人一眼看出哪些是配置、
   * 哪些只是目录里躺着。
   */
  declaredIds: string[];
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
  const listed = readContestants(raw.contestants, issues);
  const { problems, problemDirs } = await loadProblems(resolved, problemIds, issues);

  // 选手池：players.json 的声明 + 本场比赛旧写法的声明 + players/ 自动发现。
  const pool = mergeContestants(
    await loadDeclaredPlayers(resolved),
    listed.entries,
    await scanPlayerFolders(resolved),
  );
  // 参赛名单：文件里写了就按它来，没写就是池子里全上（0.1.2 的老行为）。
  const contestants = listed.explicit
    ? listed.entries.map((item) => withPoolDefaults(pool, item))
    : pool;

  issues.throwIfAny(file);

  return {
    contest: {
      id,
      title,
      problems,
      contestants,
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
    pool,
    contestantsExplicit: listed.explicit,
    declaredIds: pool.filter((item) => isDeclared(item)).map((item) => item.id),
  };
}

/** 只写这场比赛自己的配置文件：题目包、数据与选手源码都不归它管（SPEC §5.8 的同一条规矩）。 */
export async function saveContest(pkg: ContestPackage): Promise<void> {
  const text = `${JSON.stringify(serializeContest(pkg), null, 2)}\n`;
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

/** 让一位选手参加这场比赛（名单里已经有他就是原样返回）。 */
export function addContestantToContest(contest: Contest, contestant: Contestant): Contest {
  if (contest.contestants.some((item) => item.id === contestant.id)) {
    return contest;
  }
  return { ...contest, contestants: [...contest.contestants, contestant] };
}

/**
 * 保证这位选手的源码目录存在（不存在就建出来），返回绝对路径。
 *
 * 「第一次加人」时最需要这一步：面板上点完 ＋，用户第一件事就是去找那个文件夹放 `A.cpp`，
 * 让他自己去资源管理器里建三层目录是说不过去的。只建目录，不生成任何文件——
 * 选手目录里放什么、叫什么，是他的事。
 */
export async function ensureContestantFolder(
  rootDir: string,
  contestant: Contestant,
): Promise<string> {
  const target = path.resolve(rootDir, toNativeRelative(contestant.folder));
  // folder 来自配置：只在工作区里面建，别让人写个 ../.. 就往外刨目录。
  if (!isInside(target, path.resolve(rootDir))) {
    throw new Error(`选手 ${contestant.id} 的目录不在工作区里：${contestant.folder}`);
  }
  await fs.promises.mkdir(target, { recursive: true });
  return target;
}

/**
 * 把几位选手写进工作区级的声明 `.verdict/players.json`（第一次会把这个文件建出来）。
 *
 * 只用来记「这个人是谁」：显示名与源码目录。名单（谁参加哪场比赛）仍然在比赛文件里，
 * 自动发现的选手也不会被写进来——他们的名字和目录本来就是从 `players/` 推出来的。
 */
export async function declarePlayers(
  rootDir: string,
  additions: readonly Contestant[],
): Promise<void> {
  if (additions.length === 0) {
    return;
  }
  const existing = await loadDeclaredPlayers(rootDir).catch(() => []);
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of additions) {
    byId.set(item.id, item);
  }
  const file = playersFileOf(rootDir);
  const text = `${JSON.stringify(
    { version: 1, contestants: [...byId.values()] },
    null,
    2,
  )}\n`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text, 'utf8');
}

/** 把一位选手移出这场比赛：人还在选手池里，别的比赛不受影响。 */
export function removeContestantFromContest(contest: Contest, contestantId: string): Contest {
  const contestants = contest.contestants.filter((item) => item.id !== contestantId);
  return contestants.length === contest.contestants.length
    ? contest
    : { ...contest, contestants };
}

/** 一名选手的默认源码目录：players/<id>（约定优于配置，写不写都能用）。 */
function defaultFolder(id: string): string {
  return toPosixRelative(path.join(PLAYERS_DIR, id));
}

/** 名字或目录不是默认值 = 这个人是被声明过的（players.json 或比赛文件里的对象写法）。 */
function isDeclared(item: Contestant): boolean {
  return item.name !== item.id || item.folder !== defaultFolder(item.id);
}

interface ContestantList {
  /** 文件里到底写没写 contestants：没写 = 池子里所有人都参加。 */
  explicit: boolean;
  entries: Contestant[];
}

/**
 * 读参赛名单。两种写法都认：
 *   - `["alice", "bob"]`——0.1.4 起推荐，只写 id，显示名与目录按池子里的来；
 *   - `[{ "id": "alice", "name": "Alice", "folder": "players/alice" }]`——0.1.3 及更早，
 *     顺便当作「这个人是谁」的声明读进池子（否则老工作区升级后会丢显示名与目录）。
 */
function readContestants(raw: unknown, issues: ConfigIssues): ContestantList {
  if (raw === undefined) {
    // 不写也合法，而且是有意义的：players/ 下的目录会自动成为选手（见 scanPlayerFolders）。
    return { explicit: false, entries: [] };
  }
  if (!Array.isArray(raw)) {
    issues.add(`contestants 必须是数组（选手 id，或 {id,name,folder} 对象），现在是 ${describe(raw)}`);
    return { explicit: false, entries: [] };
  }

  const entries: Contestant[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `contestants[${index}]`;
    const direct = readString(item);
    if (direct !== undefined) {
      if (seen.has(direct)) {
        issues.add(`选手 id "${direct}" 重复了`);
        return;
      }
      seen.add(direct);
      entries.push({ id: direct, name: direct, folder: defaultFolder(direct) });
      return;
    }
    if (!isObject(item)) {
      issues.add(`${where} 应当是选手 id 或 {id,name,folder} 对象，现在是 ${describe(item)}`);
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

    // folder 可以不写：默认 players/<id>。写了的以写的为准（老工作区往往自定义过）。
    const folder = readString(item.folder) ?? defaultFolder(id);
    entries.push({ id, name: readString(item.name) ?? id, folder: toPosixRelative(folder) });
  });
  return { explicit: true, entries };
}

/**
 * 合并出选手池：同一 id 以**先出现的**那份为准（players.json > 比赛文件里的旧声明 > players/ 自动发现）。
 *
 * 先出现的优先级最高，是因为列表顺序就是「声明强度」：显式声明的显示名与目录，
 * 不该被自动发现的目录名盖掉。
 */
function mergeContestants(...lists: Contestant[][]): Contestant[] {
  const byId = new Map<string, Contestant>();
  for (const list of lists) {
    for (const item of list) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
  }
  return [...byId.values()];
}

/** 名单里只写了 id 时，名字与目录从池子里补；池子里也没有（还没建目录）就按默认算。 */
function withPoolDefaults(pool: Contestant[], entry: Contestant): Contestant {
  return pool.find((item) => item.id === entry.id) ?? entry;
}

/**
 * `.verdict/players.json`：工作区级的选手声明（SPEC §6.2）。
 *
 * 有了它，显示名与源码目录这类「这个人是谁」的信息就只写一处，比赛文件里只留 id 名单。
 * 不写这个文件照样能用：players/ 下的目录会被自动发现。
 */
async function loadDeclaredPlayers(rootDir: string): Promise<Contestant[]> {
  const file = playersFileOf(rootDir);
  if (!(await isFile(file))) {
    return [];
  }
  try {
    const raw = await readJsonObject(file, (target) => fs.promises.readFile(target, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.contestants;
    const issues = new ConfigIssues();
    const parsed = readContestants(list, issues);
    issues.throwIfAny(file);
    return parsed.entries;
  } catch (err) {
    // 解析不了的配置必须当场说清楚是哪一份、哪一行有问题，而不是静默当成「没有这个人」。
    const first = messageOf(err).split('\n')[0];
    throw new Error(`${file} 读不出来：${first}`);
  }
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

function serializeContest(pkg: ContestPackage): Record<string, unknown> {
  const { contest } = pkg;
  // 与 problem.json 同样的策略：先摊开 _raw 再覆盖已知字段（SPEC §6.5）。
  const base: Record<string, unknown> = {
    ...(contest._raw ?? {}),
    version: CONTEST_JSON_VERSION,
    id: contest.id,
    title: contest.title,
    maxRejudge: contest.maxRejudge,
    problems: contest.problems.map((problem) => problem.id),
  };
  if (!writesContestants(pkg)) {
    // 默认「池子里全上」的比赛不写这个字段：写了反而会把自动发现的选手固化成配置，
    // 以后往 players/ 里放新程序就不会自动进这场比赛了。
    delete base.contestants;
    return base;
  }
  return {
    ...base,
    contestants: contest.contestants.map((item) => contestantField(item)),
  };
}

/**
 * 要不要把 contestants 写进文件。
 *
 * - 文件里本来就写了 → 写（保持「显式名单」这个语义）；
 * - 本来没写，但面板上加了人或减了人 → 写（这时候它已经是一份名单了）；
 * - 本来没写、名单也还是池子的全部 → 不写（保住「放进去就算」）。
 */
function writesContestants(pkg: ContestPackage): boolean {
  if (pkg.contestantsExplicit) {
    return true;
  }
  const poolIds = new Set(pkg.pool.map((item) => item.id));
  const listed = pkg.contest.contestants;
  return listed.length !== poolIds.size || listed.some((item) => !poolIds.has(item.id));
}

/**
 * 名单里一项写成什么：默认的名字与目录就直接写 id 字符串，自定义过的写成对象。
 *
 * 这样新文件读起来就是 `["alice","bob"]`，而 0.1.3 那些把显示名写进比赛文件的老文件
 * 在改写回去时不会丢信息。
 */
function contestantField(item: Contestant): string | Record<string, string> {
  if (item.name === item.id && item.folder === defaultFolder(item.id)) {
    return item.id;
  }
  return { id: item.id, name: item.name, folder: item.folder };
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
