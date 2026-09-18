import { describe, expect, it } from 'vitest';
import { computeStandings } from '../src/core/contest/standings';
import { standingsToHtml } from '../src/core/report/html';
import { reportToJson } from '../src/core/report/json';
import { reportToMarkdown } from '../src/core/report/markdown';
import {
  DEFAULT_LIMITS,
  type Contest,
  type Problem,
  type ProblemResult,
  type Submission,
  type Verdict,
} from '../src/core/model';

function problemOf(id: string): Problem {
  return {
    id,
    name: id,
    type: 'traditional',
    limits: { ...DEFAULT_LIMITS },
    comparator: { mode: 'default' },
    subtasks: [],
    tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points: 100 }],
  };
}

function contestOf(contestants: { id: string; name: string }[]): Contest {
  return {
    id: 'demo',
    title: '演示赛',
    maxRejudge: 2,
    problems: [problemOf('A'), problemOf('B')],
    contestants: contestants.map((item) => ({ ...item, folder: `players/${item.id}` })),
  };
}

function submissionOf(
  contestant: string,
  problem: string,
  score: number,
  options: { message?: string; verdict?: Verdict } = {},
): Submission {
  const result: ProblemResult = {
    problem,
    score,
    maxScore: 100,
    cases: [
      {
        test: '1',
        verdict: options.verdict ?? (score >= 100 ? 'AC' : 'WA'),
        score,
        timeMs: 12,
        memoryKb: 2048,
        exitCode: 0,
        signal: null,
        ...(options.message === undefined ? {} : { message: options.message }),
        output: Buffer.from('4\n'),
        answer: Buffer.from('3\n'),
      },
    ],
    subtasks: [{ id: '1', score, maxScore: 100, status: score >= 100 ? 'full' : 'none' }],
    elapsedMs: 30,
  };
  return {
    id: `${contestant}-${problem}`,
    contestant,
    problem,
    source: `/w/players/${contestant}/${problem}.cpp`,
    language: 'cpp',
    verdict: options.verdict ?? (score >= 100 ? 'AC' : 'WA'),
    rejudgeCount: 0,
    time: '2026-09-13T00:00:00.000Z',
    result,
  };
}

describe('standingsToHtml', () => {
  const contest = contestOf([{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }]);
  const submissions = [
    submissionOf('alice', 'A', 100),
    submissionOf('bob', 'A', 0, { message: '第 3 行不同' }),
  ];
  const standings = computeStandings(contest, submissions);

  function html(embedData = true): string {
    return standingsToHtml(contest, standings, { theme: 'ioi', embedData }, submissions);
  }

  it('包含标题、选手与题目', () => {
    const output = html();

    expect(output).toContain('演示赛');
    expect(output).toContain('Alice');
    expect(output).toContain('Bob');
    expect(output).toContain('>A</th>');
    expect(output).toContain('>B</th>');
  });

  it('自包含：没有任何外部资源或网络请求（离线双击就能看）', () => {
    const output = html();

    for (const forbidden of ['http://', 'https://', '<link', '<script src', '@import', 'url(', 'cdn']) {
      expect(output).not.toContain(forbidden);
    }
    // 但内联的样式与脚本必须有：不然就不是「自包含」而是「功能阉割」了。
    expect(output).toContain('<style>');
    expect(output).toContain('<script>');
  });

  it('满分与 0 分的格子颜色不同，没有被糊成一类', () => {
    const output = html();

    // 满分用主题里最深的色，0 分留白。
    expect(output).toContain('background:#1f6feb');
    expect(output).toContain('background:#ffffff');
  });

  it('内嵌了逐测试点数据，单元格可点开详情', () => {
    const output = html();
    const embedded = /<script type="application\/json" id="verdict-details">(.*?)<\/script>/s.exec(
      output,
    );

    expect(embedded).not.toBeNull();
    expect(output).toMatch(/<td[^>]*data-cell="alice/);
    const parsed = JSON.parse((embedded?.[1] ?? '').replace(/\\u003c/g, '<')) as {
      contestant: string;
      problem: string;
      cases: { test: string; verdict: string; message?: string }[];
    }[];
    const alice = parsed.find((item) => item.contestant === 'Alice' && item.problem === 'A');
    expect(alice?.cases[0]).toMatchObject({ test: '1', verdict: 'AC' });
    const bob = parsed.find((item) => item.contestant === 'Bob');
    expect(bob?.cases[0]?.message).toBe('第 3 行不同');
  });

  it('embedData=false 时退化成纯静态表格', () => {
    const output = html(false);

    expect(output).not.toContain('verdict-details');
    // 注意只看单元格标签上的属性：样式表里本来就有 td.cell[data-cell] 选择器。
    expect(output).not.toMatch(/<td[^>]*data-cell/);
    expect(output).toContain('演示赛');
    // 逐测试点详情可以不内嵌，但「题目有哪些点」这份清单必须在——它不依赖提交记录。
    expect(output).toContain('题目与测试点');
    expect(output).toContain('1.in');
  });

  it('题目清单写清限制、比较方式、子任务与逐测试点', () => {
    const output = html();

    expect(output).toContain('题目与测试点');
    expect(output).toContain('时间 1000ms');
    expect(output).toContain('默认（忽略行尾空白）');
    expect(output).toContain('<th>测试点</th>');
    // 测试点表把输入 / 答案文件名原样列出来，导出的成绩单里能直接对上是哪份数据。
    expect(output).toContain('data/1.in');
    expect(output).toContain('data/1.out');
  });

  it('提交详情里带子任务表与逐测试点得分', () => {
    const output = html();
    const embedded = /<script type="application\/json" id="verdict-details">(.*?)<\/script>/s.exec(
      output,
    );
    const parsed = JSON.parse((embedded?.[1] ?? '').replace(/\\u003c/g, '<')) as {
      key: string;
      subtasks: { id: string; score: number; maxScore: number; status: string }[];
      cases: { test: string; score: number; points: number; firstDiffLine?: number }[];
    }[];

    expect(parsed[0]?.subtasks[0]).toMatchObject({ id: '1', score: 100, maxScore: 100 });
    expect(parsed[0]?.cases[0]).toMatchObject({ test: '1', score: 100, points: 100 });
  });

  it('每个可点的单元格都能在详情里查到：键与 data-cell 逐字一致', () => {
    const output = html();
    const embedded = /<script type="application\/json" id="verdict-details">(.*?)<\/script>/s.exec(
      output,
    );
    const parsed = JSON.parse((embedded?.[1] ?? '').replace(/\\u003c/g, '<')) as {
      key: string;
      contestant: string;
    }[];
    const keys = new Set(parsed.map((item) => item.key));

    // 显示名与 id 不同（alice → Alice）时必须仍然点得开——这正是
    // 「成绩单里看不到测试点详情」那个 bug 的现场。
    const cells = [...output.matchAll(/data-cell="([^"]*)"/g)].map((match) => match[1] ?? '');
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(keys.has(cell)).toBe(true);
    }
    expect(parsed.find((item) => item.contestant === 'Alice')?.key).toBe('alice\u0000A');
  });

  it('成绩单里的脚本点得开：每个格子都真的画出详情', () => {
    const result = runReportScript(html());

    expect(result.cells).toBeGreaterThan(0);
    expect(result.rendered).toBe(result.cells);
    // 详情里得有子任务表、逐测试点表，以及 WA 点上的说明。
    expect(result.text).toContain('子任务');
    expect(result.text).toContain('逐测试点');
    expect(result.text).toContain('第 3 行不同');
  });

  it('选手名字里的 HTML 被转义，不会被当成标签执行', () => {
    const evil = contestOf([{ id: 'alice', name: '<script>alert(1)</script>' }]);
    const output = standingsToHtml(
      evil,
      computeStandings(evil, []),
      { theme: 'plain', embedData: false },
      [],
    );

    expect(output).not.toContain('<script>alert(1)</script>');
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('reportToMarkdown', () => {
  it('给出得分、逐测试点表与子任务表', () => {
    const result = submissionOf('alice', 'A', 30, { message: '第 1 行不同' }).result;
    if (result === undefined) {
      throw new Error('夹具坏了');
    }

    const markdown = reportToMarkdown(result);

    expect(markdown).toContain('得分 **30 / 100**');
    expect(markdown).toContain('| 1 | WA | 30 | 12ms | 2.0MB | 第 1 行不同 |');
    expect(markdown).toContain('| 子任务 | 得分 | 满分 | 状态 |');
    expect(markdown).toContain('| 1 | 30 | 100 | none |');
  });
});

/**
 * 把成绩单里那段脚本放进最小 DOM 桩里跑一遍。
 *
 * 「成绩单里点单元格没反应」是很安静的一类 bug：页面照常渲染，只是点下去什么都不发生。
 * 键对不上、或者脚本里的函数名跟变量撞了（`table` 这个名字撞过一次），都是这种表现——
 * 所以这里不看内部实现，只认最终结果：每个带 data-cell 的格子都得画出东西。
 */
function runReportScript(html: string): { cells: number; rendered: number; text: string } {
  const embedded =
    /<script type="application\/json" id="verdict-details">([\s\S]*?)<\/script>/.exec(html)?.[1];
  const script = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html)?.[1];
  if (embedded === undefined || script === undefined) {
    throw new Error('成绩单里没有内嵌数据或脚本，夹具坏了');
  }

  interface StubNode {
    className: string;
    textContent: string;
    childNodes: StubNode[];
    style: Record<string, string>;
    appendChild(child: StubNode): StubNode;
    removeChild(child: StubNode): void;
  }

  function makeNode(): StubNode {
    return {
      className: '',
      textContent: '',
      childNodes: [],
      style: {},
      appendChild(child) {
        this.childNodes.push(child);
        return child;
      },
      removeChild(child) {
        this.childNodes = this.childNodes.filter((item) => item !== child);
      },
    };
  }

  const panel = makeNode();
  const standings = makeNode();
  // 用数组而不是 let：赋值发生在回调里，TS 的收窄会把 let 变量当成永远是 null。
  const clickHandlers: ((event: { target: unknown }) => void)[] = [];
  Object.assign(standings, {
    addEventListener: (type: string, handler: (event: { target: unknown }) => void) => {
      if (type === 'click') {
        clickHandlers.push(handler);
      }
    },
  });

  const cells = new Map<string, unknown>();
  for (const match of html.matchAll(/data-cell="([^"]*)"/g)) {
    const value = match[1] ?? '';
    const cell = {
      closest: () => cell,
      getAttribute: (name: string) => (name === 'data-cell' ? value : null),
    };
    cells.set(value, cell);
  }

  const documentStub = {
    getElementById: (id: string) =>
      id === 'verdict-details'
        ? { textContent: embedded }
        : id === 'verdict-panel'
          ? panel
          : id === 'standings'
            ? standings
            : null,
    createElement: makeNode,
    createTextNode: (text: string) => ({ textContent: text }),
  };

  // 脚本是给浏览器写的：只喂它真正用到的那几个 DOM 接口，不引入任何依赖。
  new Function('document', script)(documentStub);

  let rendered = 0;
  for (const cell of cells.values()) {
    for (const handler of clickHandlers) {
      handler({ target: cell });
    }
    if (panel.childNodes.length > 0) {
      rendered += 1;
    }
  }
  return { cells: cells.size, rendered, text: JSON.stringify(panel.childNodes) };
}

describe('reportToJson', () => {
  it('输出与答案用 base64，能无损还原', () => {
    const result = submissionOf('alice', 'A', 0).result;
    if (result === undefined) {
      throw new Error('夹具坏了');
    }

    const parsed = JSON.parse(reportToJson(result)) as {
      cases: { output: string; answer: string }[];
    };
    const first = parsed.cases[0];

    expect(first?.output).toBe(Buffer.from('4\n').toString('base64'));
    expect(Buffer.from(first?.output ?? '', 'base64').toString()).toBe('4\n');
    expect(Buffer.from(first?.answer ?? '', 'base64').toString()).toBe('3\n');
  });
});
