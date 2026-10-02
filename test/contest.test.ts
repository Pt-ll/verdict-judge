import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONTEST_FILE,
  VERDICT_DIR,
  addContestantToContest,
  addProblemToContest,
  declarePlayers,
  ensureContestantFolder,
  findContestRoot,
  legacyContestPath,
  listContests,
  loadContest,
  contestPath,
  removeContestantFromContest,
  removeProblemFromContest,
  saveContest,
  submissionsPath,
} from '../src/core/contest/contest';
import type { Contest } from '../src/core/model';
import { VERDICT_DIR as LAYOUT_VERDICT_DIR, ensureWorkspaceLayout } from '../src/core/layout';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-contest-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

/** 造一个工作区：files 的键是相对工作区根目录的路径。 */
function makeWorkspace(files: Record<string, string>): string {
  const dir = path.join(workDir, `ws-${counter++}`);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

function contestJson(body: Record<string, unknown>): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

const CONTEST = {
  version: 1,
  id: 'demo',
  title: '内部训练赛',
  maxRejudge: 2,
  problems: ['A', 'B'],
  contestants: [
    { id: 'alice', name: 'Alice', folder: 'players/alice' },
    { id: 'bob', name: 'Bob', folder: 'players/bob' },
  ],
};

function standardWorkspace(overrides: Record<string, unknown> = {}): string {
  return makeWorkspace({
    [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({ ...CONTEST, ...overrides }),
    [path.join(VERDICT_DIR, 'problems', 'A', 'problem.json')]: JSON.stringify({
      id: 'A',
      name: 'A. 求和',
    }),
    [path.join(VERDICT_DIR, 'problems', 'B', 'problem.json')]: JSON.stringify({ id: 'B' }),
  });
}

describe('loadContest', () => {
  it('把题目 id 展开成真正的题目包', async () => {
    const root = standardWorkspace();

    const pkg = await loadContest(root);

    expect(pkg.contest.id).toBe('demo');
    expect(pkg.contest.title).toBe('内部训练赛');
    expect(pkg.contest.maxRejudge).toBe(2);
    expect(pkg.contest.contestants.map((item) => item.id)).toEqual(['alice', 'bob']);
    expect(pkg.contest.contestants[0]?.name).toBe('Alice');
    expect(pkg.contest.problems.map((problem) => problem.id)).toEqual(['A', 'B']);
    expect(pkg.contest.problems[0]?.name).toBe('A. 求和');
    expect(pkg.problemDirs.get('A')).toBe(path.join(root, VERDICT_DIR, 'problems', 'A'));
    expect(pkg.rootDir).toBe(path.resolve(root));
  });

  it('一次列出所有配置问题', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({
        maxRejudge: -1,
        problems: [],
        contestants: [{ id: 'alice' }, { id: 'alice', folder: 'players/alice' }],
      }),
    });

    const message = await loadContest(root).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    // problems 为空不再算错：刚建出来的比赛就是空的（先建比赛、再加题）。
    // 0.1.4 起 folder 可以不写（默认 players/<id>），所以这里只剩两处问题。
    expect(message).toContain('2 处问题');
    expect(message).toContain('maxRejudge 必须是非负数');
    expect(message).toContain('选手 id "alice" 重复了');
  });

  it('题目包不存在时点名是哪道题', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson(CONTEST),
      [path.join(VERDICT_DIR, 'problems', 'A', 'problem.json')]: JSON.stringify({ id: 'A' }),
    });

    const message = await loadContest(root).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(message).toContain('题目 "B" 无法加载');
  });

  it('题目目录名与 problem.json 里的 id 不一致时当场纠正', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({ ...CONTEST, problems: ['A'] }),
      [path.join(VERDICT_DIR, 'problems', 'A', 'problem.json')]: JSON.stringify({ id: 'A2' }),
    });

    const message = await loadContest(root).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(message).toContain('两边要一致');
  });

  it('不是 JSON 时给出文件名', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: '{ oops',
    });

    const message = await loadContest(root).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(message).toContain(CONTEST_FILE);
    expect(message).toContain('不是合法 JSON');
  });
});

describe('saveContest', () => {
  it('未知字段保留，已知字段覆盖，题目写回 id 列表', async () => {
    const root = standardWorkspace({ customNote: '别丢了我', version: 99 });
    const pkg = await loadContest(root);
    pkg.contest.title = '改过的标题';
    pkg.contest.maxRejudge = 5;

    await saveContest(pkg);

    // 单场比赛的旧布局：saveContest 写回它原来那个文件，不会另起一个。
    const text = fs.readFileSync(legacyContestPath(root), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);

    const reloaded = await loadContest(root);
    expect(reloaded.contest.title).toBe('改过的标题');
    expect(reloaded.contest.maxRejudge).toBe(5);
    expect(reloaded.contest._raw?.customNote).toBe('别丢了我');
    // version 被已知字段覆盖回 1，而不是保留 _raw 里的 99。
    expect(reloaded.contest._raw?.version).toBe(1);
    // 写回的是 id 列表，不是展开后的题目对象。
    expect(reloaded.contest._raw?.problems).toEqual(['A', 'B']);
  });
});

describe('players/ 自动识别选手', () => {
  it('problems 与 contestants 都能不写：刚建出来的比赛也读得出来', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({
        id: 'fresh',
        title: '刚建出来的比赛',
        maxRejudge: 3,
        problems: [],
      }),
    });

    const pkg = await loadContest(root);

    expect(pkg.contest.id).toBe('fresh');
    expect(pkg.contest.problems).toEqual([]);
    expect(pkg.contest.contestants).toEqual([]);
    expect(pkg.pool).toEqual([]);
    expect(pkg.contestantsExplicit).toBe(false);
  });

  it('players/ 下含源码的目录自动成为选手，空目录与普通文件都不算', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({ id: 'demo', problems: [] }),
      'players/10/A.cpp': 'int main() { return 0; }\n',
      'players/2/A.cpp': 'int main() { return 0; }\n',
      'players/empty/.keep': '',
      'players/notes.txt': '不是目录\n',
    });

    const pkg = await loadContest(root);

    // 数字感知排序：2 排在 10 前面。
    expect(pkg.contest.contestants.map((item) => item.id)).toEqual(['2', '10']);
    expect(pkg.contest.contestants[0]?.folder).toBe('players/2');
    expect(pkg.pool.map((item) => item.id)).toEqual(['2', '10']);
    // 只是目录里躺着、没声明过 → 面板上算「自动发现」。
    expect(pkg.declaredIds).toEqual([]);
    expect(pkg.contestantsExplicit).toBe(false);
  });

  it('名单里写过的选手用它的显示名，自动发现的只补缺的那几个', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({
        id: 'demo',
        problems: [],
        contestants: [{ id: 'alice', name: 'Alice', folder: 'players/alice' }],
      }),
      'players/alice/A.cpp': 'int main() { return 0; }\n',
      'players/bob/A.cpp': 'int main() { return 0; }\n',
    });

    const pkg = await loadContest(root);

    // 写了名单就只按名单来：bob 在池子里，但这场不参加（0.1.4 的「每场挑人」）。
    expect(pkg.contest.contestants.map((item) => item.id)).toEqual(['alice']);
    expect(pkg.contest.contestants[0]?.name).toBe('Alice');
    expect(pkg.pool.map((item) => item.id)).toEqual(['alice', 'bob']);
    expect(pkg.declaredIds).toEqual(['alice']);
    expect(pkg.contestantsExplicit).toBe(true);
  });

  it('默认「全上」的比赛不会把自动发现的人写进文件，但下次读还算数', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({ id: 'demo', problems: [] }),
      'players/carol/A.cpp': 'int main() { return 0; }\n',
    });

    const pkg = await loadContest(root);
    await saveContest(pkg);

    const written = JSON.parse(fs.readFileSync(legacyContestPath(root), 'utf8')) as {
      contestants?: unknown;
    };
    // 字段干脆不写出去：写进去等于把「自动发现」固化成名单，以后放进 players/ 的新人就不自动参赛了。
    expect(written.contestants).toBeUndefined();

    const again = await loadContest(root);
    expect(again.contest.contestants.map((item) => item.id)).toEqual(['carol']);
  });

  it('players.json 是选手池的声明处：显示名与目录只写一处，比赛文件只列 id', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, 'players.json')]: contestJson({
        contestants: [{ id: 'alice', name: 'Alice', folder: 'players/alice' }],
      }),
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({
        id: 'demo',
        problems: [],
        contestants: ['alice', 'bob'],
      }),
      'players/alice/A.cpp': 'int main() { return 0; }\n',
      'players/bob/A.cpp': 'int main() { return 0; }\n',
      'players/carol/A.cpp': 'int main() { return 0; }\n',
    });

    const pkg = await loadContest(root);

    // 池子 = players.json 的声明 + players/ 自动发现；只列 id 的名单从池子里取名字。
    expect(pkg.pool.map((item) => item.id)).toEqual(['alice', 'bob', 'carol']);
    expect(pkg.declaredIds).toEqual(['alice']);
    expect(pkg.contest.contestants.map((item) => item.id)).toEqual(['alice', 'bob']);
    expect(pkg.contest.contestants[0]?.name).toBe('Alice');
    expect(pkg.contestantsExplicit).toBe(true);
  });

  it('两场比赛各自挑人：同一批池子，名单互不影响', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, 'contests', 'spring.json')]: contestJson({
        id: 'spring',
        problems: [],
        contestants: ['alice'],
      }),
      [path.join(VERDICT_DIR, 'contests', 'autumn.json')]: contestJson({
        id: 'autumn',
        problems: [],
        contestants: ['alice', 'bob'],
      }),
      'players/alice/A.cpp': 'int main() { return 0; }\n',
      'players/bob/A.cpp': 'int main() { return 0; }\n',
    });

    const spring = await loadContest(root, 'spring');
    const autumn = await loadContest(root, 'autumn');

    expect(spring.contest.contestants.map((item) => item.id)).toEqual(['alice']);
    expect(autumn.contest.contestants.map((item) => item.id)).toEqual(['alice', 'bob']);
    // 池子是一样的：可选的人和「这场谁上」是两件事。
    expect(spring.pool.map((item) => item.id)).toEqual(['alice', 'bob']);
    expect(autumn.pool.map((item) => item.id)).toEqual(['alice', 'bob']);
  });

  it('显式的名单写回文件时是 id 数组，自定义过名字的保持对象形式', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, 'players.json')]: contestJson({
        contestants: [{ id: 'alice', name: 'Alice', folder: 'players/alice' }],
      }),
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({
        id: 'demo',
        problems: [],
        contestants: ['alice', 'bob'],
      }),
      'players/alice/A.cpp': 'int main() { return 0; }\n',
      'players/bob/A.cpp': 'int main() { return 0; }\n',
    });

    const pkg = await loadContest(root);
    await saveContest(pkg);

    const written = JSON.parse(fs.readFileSync(legacyContestPath(root), 'utf8')) as {
      contestants: unknown[];
    };
    expect(written.contestants).toEqual([
      { id: 'alice', name: 'Alice', folder: 'players/alice' },
      'bob',
    ]);
  });

  it('加减参赛选手是纯函数：不动池子，也不动别的比赛', () => {
    const contest: Contest = {
      id: 'c',
      title: 'c',
      maxRejudge: 0,
      problems: [],
      contestants: [],
    };
    const alice = { id: 'alice', name: 'Alice', folder: 'players/alice' };

    const added = addContestantToContest(contest, alice);
    expect(added.contestants.map((item) => item.id)).toEqual(['alice']);
    expect(addContestantToContest(added, alice).contestants).toHaveLength(1);
    expect(removeContestantFromContest(added, 'alice').contestants).toEqual([]);
    expect(contest.contestants).toEqual([]);
  });
});

describe('第一次用工作区时把目录建好', () => {
  it('ensureWorkspaceLayout 一次建齐 .verdict 下的四个目录与 players/', async () => {
    const root = path.join(workDir, `fresh-${counter++}`);
    fs.mkdirSync(root, { recursive: true });

    const created = await ensureWorkspaceLayout(root);

    for (const dir of ['contests', 'problems', 'data', 'submissions']) {
      expect(fs.existsSync(path.join(root, LAYOUT_VERDICT_DIR, dir))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'players'))).toBe(true);
    expect(created.length).toBeGreaterThanOrEqual(5);

    // 再叫一次不会重复报「新建」，也不会碰任何已有内容。
    fs.writeFileSync(path.join(root, 'players', 'keep.txt'), '别动我\n');
    expect(await ensureWorkspaceLayout(root)).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'players', 'keep.txt'), 'utf8')).toBe('别动我\n');
  });

  it('加选手时把 players/<id>/ 建出来；写声明不会覆盖已有的人', async () => {
    const root = path.join(workDir, `declare-${counter++}`);
    fs.mkdirSync(root, { recursive: true });

    const alice = { id: 'alice', name: 'Alice', folder: 'players/alice' };
    const folder = await ensureContestantFolder(root, alice);
    expect(folder).toBe(path.join(root, 'players', 'alice'));
    expect(fs.existsSync(folder)).toBe(true);

    await declarePlayers(root, [alice]);
    await declarePlayers(root, [{ id: 'bob', name: 'Bob', folder: 'players/bob' }]);

    const declared = JSON.parse(
      fs.readFileSync(path.join(root, LAYOUT_VERDICT_DIR, 'players.json'), 'utf8'),
    ) as { contestants: { id: string }[] };
    expect(declared.contestants.map((item) => item.id)).toEqual(['alice', 'bob']);

    // 同一个 id 再声明一次是覆盖，不是追加。
    await declarePlayers(root, [{ id: 'alice', name: 'Alice Liddell', folder: 'players/alice' }]);
    const text = fs.readFileSync(path.join(root, LAYOUT_VERDICT_DIR, 'players.json'), 'utf8');
    expect((JSON.parse(text) as { contestants: unknown[] }).contestants).toHaveLength(2);
    expect(text).toContain('Alice Liddell');
  });

  it('选手目录写在工作区外面时拒绝创建（配置写错不该往外刨目录）', async () => {
    const root = path.join(workDir, `outside-${counter++}`);
    fs.mkdirSync(root, { recursive: true });

    await expect(
      ensureContestantFolder(root, { id: 'eve', name: 'eve', folder: '../eve' }),
    ).rejects.toThrow(/不在工作区里/);
  });
});

describe('一个工作区里放多场比赛', () => {
  /** 两场比赛 + 一个共用题目库：题目 B 两场都考，这是「题目可以重叠」的现场。 */
  function twoContests(): string {
    return makeWorkspace({
      [path.join(VERDICT_DIR, 'contests', 'spring.json')]: contestJson({
        id: 'spring',
        title: '春季赛',
        problems: ['A', 'B'],
      }),
      [path.join(VERDICT_DIR, 'contests', 'autumn.json')]: contestJson({
        id: 'autumn',
        title: '秋季赛',
        problems: ['B'],
      }),
      [path.join(VERDICT_DIR, 'problems', 'A', 'problem.json')]: JSON.stringify({ id: 'A' }),
      [path.join(VERDICT_DIR, 'problems', 'B', 'problem.json')]: JSON.stringify({ id: 'B' }),
      // 旧布局的单场比赛也一起放在这儿：两种布局必须共存。
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({ id: 'legacy', title: '老比赛', problems: [] }),
    });
  }

  it('列出全部比赛，新旧布局都在', async () => {
    const root = twoContests();

    const refs = await listContests(root);

    expect(refs.map((item) => item.id)).toEqual(['autumn', 'legacy', 'spring']);
    expect(refs.find((item) => item.id === 'legacy')?.legacy).toBe(true);
    expect(refs.find((item) => item.id === 'spring')?.legacy).toBe(false);
  });

  it('按 id 读某一场，题目重叠互不影响，记录文件也各归各的', async () => {
    const root = twoContests();

    const spring = await loadContest(root, 'spring');
    const autumn = await loadContest(root, 'autumn');

    expect(spring.contest.title).toBe('春季赛');
    expect(spring.contest.problems.map((item) => item.id)).toEqual(['A', 'B']);
    expect(autumn.contest.problems.map((item) => item.id)).toEqual(['B']);
    // 同一个题目包目录被两场比赛共用，这正是 0.1.3 要的「题目可以重叠」。
    expect(spring.problemDirs.get('B')).toBe(autumn.problemDirs.get('B'));
    expect(spring.file).toBe(contestPath(root, 'spring'));
    expect(spring.submissionsFile).toBe(submissionsPath(root, 'spring'));
    expect(autumn.submissionsFile).not.toBe(spring.submissionsFile);
  });

  it('不传 id 时给出排在最前面的那一场，而不是报错', async () => {
    const root = twoContests();

    const pkg = await loadContest(root);

    expect(pkg.contest.id).toBe('autumn');
  });

  it('文件里的 id 与文件名不一致时当场纠正', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, 'contests', 'spring.json')]: contestJson({ id: 'summer' }),
    });

    const message = await loadContest(root, 'spring').then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(message).toContain('两边要一致');
  });

  it('两场比赛重名时明说改哪一个', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, 'contests', 'spring.json')]: contestJson({ id: 'spring' }),
      [path.join(VERDICT_DIR, CONTEST_FILE)]: contestJson({ id: 'spring' }),
    });

    await expect(listContests(root)).rejects.toThrow(/两场比赛都叫 "spring"/);
  });

  it('加题、摘题都只动这一场的题目列表', () => {
    const contest = {
      id: 'c',
      title: 'c',
      maxRejudge: 0,
      problems: [],
      contestants: [],
    };
    const problem = {
      id: 'A',
      name: 'A',
      type: 'traditional' as const,
      limits: { timeMs: 1, memoryMb: 1, stackMb: 1, outputKb: 1 },
      comparator: { mode: 'default' as const },
      subtasks: [],
      tests: [],
    };

    const added = addProblemToContest(contest, problem);
    expect(added.problems.map((item) => item.id)).toEqual(['A']);
    // 加两次不会变成两道题。
    expect(addProblemToContest(added, problem).problems).toHaveLength(1);
    expect(removeProblemFromContest(added, 'A').problems).toEqual([]);
    // 原对象不被改动（纯函数，面板与命令共用）。
    expect(contest.problems).toEqual([]);
  });

  it('多场比赛：contests/ 下有目录就算工作区根，用不着 contest.json', async () => {
    const root = makeWorkspace({
      [path.join(VERDICT_DIR, 'contests', 'spring.json')]: contestJson({ id: 'spring' }),
      'players/alice/A.cpp': 'int main() {}',
    });

    expect(await findContestRoot(path.join(root, 'players'), root)).toBe(path.resolve(root));
  });
});

describe('findContestRoot', () => {
  it('从子目录向上找到工作区根', async () => {
    const root = standardWorkspace();
    fs.mkdirSync(path.join(root, 'players', 'alice'), { recursive: true });

    const found = await findContestRoot(path.join(root, 'players', 'alice'), root);

    expect(found).toBe(path.resolve(root));
  });

  it('不在工作区里时不越过边界乱找', async () => {
    const root = standardWorkspace();
    const outside = makeWorkspace({ 'players/alice/A.cpp': 'int main() {}' });

    expect(await findContestRoot(path.join(outside, 'players'), outside)).toBeNull();
    expect(await findContestRoot(path.join(root, 'players'), root)).toBe(path.resolve(root));
  });
});
