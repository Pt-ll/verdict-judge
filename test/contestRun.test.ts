import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectToolchain } from '../src/core/compiler';
import { findContestantSource } from '../src/core/contest/sources';
import { languageOf, planContest } from '../src/core/contest/plan';
import { loadContest } from '../src/core/contest/contest';
import {
  loadSubmissions,
  mergeSubmissions,
  saveSubmissions,
} from '../src/core/contest/submissions';
import { canRejudge, computeStandings } from '../src/core/contest/standings';
import { DEFAULT_LIMITS, type Submission } from '../src/core/model';
import { judgeContest, rejudgeSubmission, type EngineOptions } from '../src/engineFacade';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-contest-run-'));
const cacheDir = path.join(workDir, 'cache');

let available = false;

beforeAll(async () => {
  const toolchain = await detectToolchain();
  available = toolchain !== null && toolchain.kind !== 'python';
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const SUM_OK = [
  '#include <cstdio>',
  'int main() {',
  '  int a = 0, b = 0;',
  '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
  '  std::printf("%d\\n", a + b);',
  '  return 0;',
  '}',
  '',
].join('\n');

const SUM_WRONG = SUM_OK.replace('a + b', 'a - b');
const BROKEN = '#include <cstdio>\nint main() { return undefined_symbol; }\n';

function options(): EngineOptions {
  return {
    compilerPath: '',
    flags: ['-O2', '-std=c++17'],
    limits: { ...DEFAULT_LIMITS, timeMs: 5000 },
    comparator: { mode: 'default' },
    cacheDir,
  };
}

let counter = 0;

interface Fixture {
  root: string;
  sources: Record<string, string>;
}

/** 造一个比赛工作区：题目 A 一个测试点，选手按 sources 里的键（"alice" / "bob"）放源码。 */
function makeContest(sources: Record<string, string>, maxRejudge = 1): Fixture {
  const root = path.join(workDir, `ws-${counter++}`);
  const write = (relative: string, text: string): void => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };

  const contestants = Object.keys(sources);
  write(
    path.join('.verdict', 'contest.json'),
    JSON.stringify(
      {
        version: 1,
        id: 'demo',
        title: '演示赛',
        maxRejudge,
        problems: ['A'],
        contestants: contestants.map((id) => ({
          id,
          name: id,
          folder: `players/${id}`,
        })),
      },
      null,
      2,
    ),
  );
  write(
    path.join('.verdict', 'problems', 'A', 'problem.json'),
    JSON.stringify({
      id: 'A',
      name: 'A. 求和',
      limits: { timeMs: 5000, memoryMb: 256, stackMb: 256, outputKb: 4096 },
      tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points: 100 }],
    }),
  );
  write(path.join('.verdict', 'problems', 'A', 'data', '1.in'), '1 2\n');
  write(path.join('.verdict', 'problems', 'A', 'data', '1.out'), '3\n');
  for (const [id, source] of Object.entries(sources)) {
    write(path.join('players', id, 'A.cpp'), source);
  }

  return { root, sources };
}

describe('planContest', () => {
  it('按选手 × 题目规划任务，找不到源码的记进 missing', async () => {
    const fixture = makeContest({ alice: SUM_OK });
    const pkg = await loadContest(fixture.root);
    // 手动加一个没有源码的选手：模拟「还没交」。
    pkg.contest.contestants.push({ id: 'bob', name: 'bob', folder: 'players/bob' });

    const plan = await planContest(pkg);

    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.contestant.id).toBe('alice');
    expect(plan.tasks[0]?.source).toBe(path.join(fixture.root, 'players', 'alice', 'A.cpp'));
    expect(plan.tasks[0]?.problemRoot).toBe(
      path.join(fixture.root, '.verdict', 'problems', 'A'),
    );
    expect(plan.missing).toEqual([{ contestant: 'bob', problem: 'A' }]);
  });

  it('语言由后缀推断', () => {
    expect(languageOf('/w/players/alice/A.cpp')).toBe('cpp');
    expect(languageOf('/w/players/alice/A.py')).toBe('python');
    expect(languageOf('/w/players/alice/A.txt')).toBe('txt');
  });

  it('findContestantSource 在比赛目录结构下能找到题目文件', async () => {
    const fixture = makeContest({ alice: SUM_OK });
    const pkg = await loadContest(fixture.root);
    const contestant = pkg.contest.contestants[0];
    const problem = pkg.contest.problems[0];
    if (contestant === undefined || problem === undefined) {
      throw new Error('夹具坏了');
    }

    const found = await findContestantSource(pkg.rootDir, contestant, problem);

    expect(found).toBe(path.join(fixture.root, 'players', 'alice', 'A.cpp'));
  });
});

describe('提交记录的保存与读取', () => {
  it('分数/判定/耗时/内存都留着，输出与答案不落盘', async () => {
    const verdictDir = path.join(workDir, 'store');
    const submission: Submission = {
      id: 'alice-A-1',
      contestant: 'alice',
      problem: 'A',
      source: '/w/players/alice/A.cpp',
      language: 'cpp',
      verdict: 'WA',
      rejudgeCount: 1,
      time: '2026-09-13T00:00:00.000Z',
      result: {
        problem: 'A',
        score: 30,
        maxScore: 100,
        elapsedMs: 42,
        subtasks: [{ id: '1', score: 30, maxScore: 30, status: 'full' }],
        cases: [
          {
            test: '1',
            verdict: 'WA',
            score: 30,
            timeMs: 12,
            memoryKb: 2048,
            exitCode: 0,
            signal: null,
            message: '第 3 行不同',
            firstDiffLine: 3,
            output: Buffer.from('4\n'),
            answer: Buffer.from('3\n'),
          },
        ],
      },
    };

    await saveSubmissions(verdictDir, [submission]);
    const loaded = await loadSubmissions(verdictDir);

    expect(loaded).toHaveLength(1);
    const back = loaded[0];
    expect(back?.verdict).toBe('WA');
    expect(back?.rejudgeCount).toBe(1);
    expect(back?.time).toBe('2026-09-13T00:00:00.000Z');
    expect(back?.result?.score).toBe(30);
    expect(back?.result?.cases[0]).toMatchObject({
      test: '1',
      verdict: 'WA',
      timeMs: 12,
      memoryKb: 2048,
      firstDiffLine: 3,
    });
    // 输出与答案不落盘，读回来是空 Buffer（类型不变，调用方不用到处判空）。
    expect(back?.result?.cases[0]?.output.length).toBe(0);
    expect(back?.result?.subtasks[0]?.status).toBe('full');
  });

  it('文件不存在时返回空数组；被改坏时报错而不是猜', async () => {
    expect(await loadSubmissions(path.join(workDir, 'nope.json'))).toEqual([]);

    const verdictDir = path.join(workDir, 'broken');
    fs.mkdirSync(verdictDir, { recursive: true });
    const broken = path.join(verdictDir, 'submissions.json');
    fs.writeFileSync(broken, '{"submissions": "oops"}');
    // loadSubmissions 收的是文件路径：每场比赛一份记录，文件在哪由 ContestPackage 说了算。
    await expect(loadSubmissions(broken)).rejects.toThrow(/submissions 必须是数组/);
  });

  it('合并时按「选手 × 题目」替换，不会越跑越多', () => {
    const first = [
      { id: 'a', contestant: 'alice', problem: 'A' },
      { id: 'b', contestant: 'bob', problem: 'A' },
    ] as Submission[];
    const second = [{ id: 'c', contestant: 'alice', problem: 'A' }] as Submission[];

    const merged = mergeSubmissions(first, second);

    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.contestant === 'alice')?.id).toBe('c');
  });
});

describe('judgeContest（真编译）', () => {
  it('多选手多题：分数与名次正确，编译失败记 CE 而不是 UKE', async () => {
    if (!available) {
      return;
    }
    const fixture = makeContest({ alice: SUM_OK, bob: SUM_WRONG, carol: BROKEN });
    const pkg = await loadContest(fixture.root);
    const progress: string[] = [];

    const result = await judgeContest(pkg, options(), undefined, {
      onProgress: (stage) => progress.push(stage),
    });

    expect(result.cancelled).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.submissions).toHaveLength(3);

    const byContestant = new Map(result.submissions.map((item) => [item.contestant, item]));
    expect(byContestant.get('alice')?.verdict).toBe('AC');
    expect(byContestant.get('alice')?.result?.score).toBe(100);
    expect(byContestant.get('bob')?.verdict).toBe('WA');
    expect(byContestant.get('bob')?.result?.score).toBe(0);
    // 编译失败要如实标 CE：标成 UKE 会让人以为是评测环境的问题。
    expect(byContestant.get('carol')?.verdict).toBe('CE');
    expect(byContestant.get('carol')?.result?.maxScore).toBe(100);
    expect(byContestant.get('carol')?.message).toContain('编译失败');

    expect(progress.some((stage) => stage.includes('alice × A'))).toBe(true);

    const standings = computeStandings(pkg.contest, result.submissions);
    expect(standings.totals).toEqual([
      { contestant: 'alice', score: 100 },
      { contestant: 'bob', score: 0 },
      { contestant: 'carol', score: 0 },
    ]);
    expect(standings.ranks[0]).toEqual({ contestant: 'alice', rank: 1, score: 100 });
  });

  it('重测：id 与提交时间不变，rejudgeCount 加一，且受上限约束', async () => {
    if (!available) {
      return;
    }
    const fixture = makeContest({ alice: SUM_OK }, 1);
    const pkg = await loadContest(fixture.root);
    const judged = await judgeContest(pkg, options());
    const submission = judged.submissions[0];
    if (submission === undefined) {
      throw new Error('应当有一条提交');
    }

    expect(canRejudge(submission, pkg.contest)).toBe(true);
    const again = await rejudgeSubmission(submission, pkg, options());

    expect(again.id).toBe(submission.id);
    expect(again.time).toBe(submission.time);
    expect(again.rejudgeCount).toBe(1);
    expect(again.verdict).toBe('AC');

    // 到了上限就不许再重测（SPEC §5.7）。
    expect(canRejudge(again, pkg.contest)).toBe(false);
  });

  it('取消后只留下已经跑完的提交', async () => {
    if (!available) {
      return;
    }
    const fixture = makeContest({ alice: SUM_OK, bob: SUM_OK });
    const pkg = await loadContest(fixture.root);
    let cancelled = false;

    const result = await judgeContest(pkg, options(), undefined, {
      onSubmission: () => {
        // 跑完第一条就取消：模拟用户点了「取消当前任务」。
        cancelled = true;
      },
    });

    expect(cancelled).toBe(true);
    expect(result.submissions.length).toBeGreaterThanOrEqual(1);
  });
});
