import type { Contest, Problem, Standings, Submission, Verdict } from '../model';
import { bestSubmissions, submissionKey } from '../contest/standings';

export type ReportTheme = 'ioi' | 'joi' | 'plain';

export interface ReportOptions {
  theme: ReportTheme;
  /** 是否把逐测试点结果内嵌进去（内嵌后单元格可点开详情）。 */
  embedData: boolean;
}

/**
 * 主题配色：从「没分/低分」到「满分」的色阶。
 *
 * 0 分不着色（留白），这样一眼就能看出「这一格是空的」，
 * 而不是被最浅的底色糊成「拿了很少的分」。
 */
const THEMES: Record<ReportTheme, string[]> = {
  ioi: ['#e8f0fe', '#cfe3ff', '#9ecbff', '#5ea1f7', '#1f6feb'],
  joi: ['#eafaef', '#c9f0d5', '#96e0ad', '#57c47c', '#2f8f4e'],
  plain: ['#f5f5f5', '#e6e6e6', '#d0d0d0', '#b0b0b0', '#8a8a8a'],
};

interface CellDetail {
  /**
   * 单元格的查找键（`选手 id + \0 + 题目 id`），必须与 `<td data-cell>` 上的值逐字相同。
   *
   * 不能拿 contestant 兼职：那是给人看的显示名（alice → Alice），拿它当键的话
   * 点了格子查不到东西——「成绩单里看不到测试点详情」就是这么来的。
   */
  key: string;
  contestant: string;
  problem: string;
  score: number;
  maxScore: number;
  /** 没提交过时是占位符「—」。 */
  verdict: Verdict | '—';
  message?: string;
  time?: string;
  rejudgeCount: number;
  subtasks: {
    id: string;
    score: number;
    maxScore: number;
    status: string;
  }[];
  cases: {
    test: string;
    verdict: Verdict;
    /** 这个点拿到的分数与它的满分（按测试点算，不是子任务折扣后的分）。 */
    score: number;
    points: number;
    timeMs: number;
    memoryKb: number;
    message?: string;
    firstDiffLine?: number;
  }[];
}

/**
 * 生成自包含的榜单 HTML（SPEC §5.9）。
 *
 * 「自包含」是硬要求：内联 CSS、内联数据、内联脚本，没有字体、CDN、图片或任何网络请求，
 * 断网双击也能打开。导出的事后报告往往要发给别人、归档很久，依赖外部资源迟早会坏。
 *
 * 第四个参数（提交记录）是可选的：给了就能点开单元格看逐测试点详情，
 * 不给就退化成一张纯静态表格。
 */
export function standingsToHtml(
  contest: Contest,
  standings: Standings,
  opts: ReportOptions,
  submissions: Submission[] = [],
): string {
  const names = new Map(contest.contestants.map((item) => [item.id, item.name]));
  const cells = new Map(
    standings.cells.map((item) => [submissionKey(item.contestant, item.problem), item]),
  );
  const best = bestSubmissions(contest, submissions);

  const head = [
    '<th class="rank">#</th>',
    '<th class="name">选手</th>',
    ...contest.problems.map((problem) => `<th>${escapeHtml(problem.id)}</th>`),
    '<th class="total">总分</th>',
  ].join('');

  const rows = standings.ranks
    .map((entry) => {
      const body = contest.problems
        .map((problem) => renderCell(entry.contestant, problem.id, cells, best, opts))
        .join('');
      const name = names.get(entry.contestant) ?? entry.contestant;
      return (
        `<tr><td class="rank">${String(entry.rank)}</td>` +
        `<td class="name">${escapeHtml(name)}</td>${body}` +
        `<td class="total">${String(entry.score)}</td></tr>`
      );
    })
    .join('\n');

  // 题目与测试点清单是「成绩单里能看到测试点详情」的一半：不点任何单元格时，
  // 也该看得出每道题有哪些点、分值怎么分、数据在哪。提交详情是另一半。
  const problems = renderProblems(contest);
  const details = opts.embedData ? renderDetails(contest, standings, best) : '';

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(contest.title)} · 榜单</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(contest.title)}</h1>`,
    `<p class="meta">比赛 ${escapeHtml(contest.id)} · ${String(contest.contestants.length)} 名选手 · ${String(contest.problems.length)} 道题</p>`,
    `<table id="standings"><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table>`,
    problems,
    details,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 题目清单：限制、比较方式、子任务与逐测试点表。全是静态内容，不依赖有没有提交。 */
function renderProblems(contest: Contest): string {
  if (contest.problems.length === 0) {
    return '';
  }
  const sections = contest.problems.map((problem) => renderProblem(problem)).join('\n');
  return ['<h2>题目与测试点</h2>', sections].join('\n');
}

function renderProblem(problem: Problem): string {
  const limits =
    `时间 ${String(problem.limits.timeMs)}ms · 内存 ${String(problem.limits.memoryMb)}MB · ` +
    `栈 ${String(problem.limits.stackMb)}MB · 输出上限 ${String(problem.limits.outputKb)}KB`;

  const subtaskRows = problem.subtasks
    .map((subtask) => {
      const total = problem.tests
        .filter((test) => subtask.tests.includes(test.id))
        .reduce((sum, test) => sum + (test.points ?? 1), 0);
      return (
        '<tr>' +
        `<td>${escapeHtml(subtask.id)}</td>` +
        `<td class="name">${escapeHtml(subtask.name ?? `子任务 ${subtask.id}`)}</td>` +
        `<td>${String(subtask.points)}</td>` +
        `<td>${String(total)}</td>` +
        `<td class="name">${escapeHtml(subtask.tests.join('、') || '（没有测试点）')}</td>` +
        `<td class="name">${escapeHtml(subtask.dependsOn.join('、') || '无')}</td>` +
        `<td>${subtask.scoring === 'sum' ? '按点求和' : '组内全对'}</td>` +
        '</tr>'
      );
    })
    .join('');

  const testRows = problem.tests
    .map(
      (test) =>
        '<tr>' +
        `<td>${escapeHtml(test.id)}</td>` +
        `<td>${String(test.points ?? 1)}</td>` +
        `<td class="name">${escapeHtml(test.subtask ?? '—')}</td>` +
        `<td class="name mono">${escapeHtml(test.input)}</td>` +
        `<td class="name mono">${escapeHtml(test.answer)}</td>` +
        '</tr>',
    )
    .join('');

  return [
    '<section class="problem">',
    `<h3>${escapeHtml(problem.id)} · ${escapeHtml(problem.name)}</h3>`,
    `<p class="meta">${escapeHtml(limits)}<br>比较方式：${escapeHtml(comparatorText(problem))}` +
      `${problem.type === 'interactive' && problem.comparator.mode !== 'interactive' ? ' · 交互题' : ''}</p>`,
    problem.subtasks.length === 0
      ? '<p class="meta">没有分子任务：每个测试点按自己的分值直接计入总分。</p>'
      : [
          '<table class="detail"><thead><tr>',
          '<th>子任务</th><th class="name">名称</th><th>分值</th><th>点分合计</th>',
          '<th class="name">测试点</th><th class="name">依赖</th><th>计分</th>',
          '</tr></thead><tbody>',
          subtaskRows,
          '</tbody></table>',
        ].join(''),
    problem.tests.length === 0
      ? '<p class="meta">这道题还没有登记测试点。</p>'
      : [
          '<table class="detail"><thead><tr>',
          '<th>测试点</th><th>分值</th><th class="name">子任务</th>',
          '<th class="name">输入</th><th class="name">答案</th>',
          '</tr></thead><tbody>',
          testRows,
          '</tbody></table>',
        ].join(''),
    '</section>',
  ].join('\n');
}

/** 比较方式说人话，和侧边栏面板上的措辞保持一致。 */
function comparatorText(problem: Problem): string {
  const config = problem.comparator;
  if (config.mode === 'real') {
    const abs = config.absEps ?? 0.000001;
    const rel = config.relEps ?? 0.000001;
    return `实数比较（绝对 ${String(abs)} / 相对 ${String(rel)}）`;
  }
  if (config.mode === 'spj') {
    return `testlib SPJ（${config.spj ?? '未指定 checker'}）`;
  }
  if (config.mode === 'interactive') {
    return `交互题（${config.interactor ?? '未指定 interactor'}）`;
  }
  return config.mode === 'line' ? '逐行比较（报告首个不同行）' : '默认（忽略行尾空白）';
}

function renderCell(
  contestant: string,
  problem: string,
  cells: Map<string, Standings['cells'][number]>,
  best: Map<string, Submission>,
  opts: ReportOptions,
): string {
  const key = submissionKey(contestant, problem);
  const cell = cells.get(key);
  const submission = best.get(key);
  const score = cell?.score ?? 0;
  const maxScore = submission?.result?.maxScore ?? 0;
  const ratio = maxScore > 0 ? score / maxScore : 0;
  const verdict = cell?.verdict ?? '—';

  const background = ratio > 0 ? colorOf(ratio, opts.theme) : '#ffffff';
  const color = ratio >= 0.8 ? '#ffffff' : '#1f2328';
  const label = maxScore > 0 ? `${String(score)}<span class="max">/${String(maxScore)}</span>` : String(score);
  // 内嵌了逐步结果、且这一格确实有提交，才做成可点的；否则就是个普通单元格。
  const clickable = opts.embedData && submission !== undefined;
  const attribute = clickable ? ` data-cell="${escapeAttribute(key)}"` : '';

  return (
    `<td class="cell" style="background:${background};color:${color}"${attribute}>` +
    `<span class="score">${label}</span><span class="verdict">${escapeHtml(verdict)}</span></td>`
  );
}

function renderDetails(
  contest: Contest,
  standings: Standings,
  best: Map<string, Submission>,
): string {
  const points = new Map<string, number>();
  for (const problem of contest.problems) {
    for (const test of problem.tests) {
      points.set(submissionKey(problem.id, test.id), test.points ?? 1);
    }
  }

  const details: CellDetail[] = standings.cells
    .map((cell): CellDetail | null => {
      const submission = best.get(submissionKey(cell.contestant, cell.problem));
      if (submission === undefined) {
        return null;
      }
      return {
        key: submissionKey(cell.contestant, cell.problem),
        contestant: cell.contestant,
        problem: cell.problem,
        score: cell.score,
        maxScore: submission.result?.maxScore ?? 0,
        verdict: cell.verdict ?? '—',
        ...(submission.message === undefined ? {} : { message: submission.message }),
        time: submission.time,
        rejudgeCount: submission.rejudgeCount,
        subtasks: (submission.result?.subtasks ?? []).map((item) => ({
          id: item.id,
          score: item.score,
          maxScore: item.maxScore,
          status: item.status,
        })),
        cases: (submission.result?.cases ?? []).map((item) => ({
          test: item.test,
          verdict: item.verdict,
          score: item.score,
          points: points.get(submissionKey(cell.problem, item.test)) ?? 1,
          timeMs: item.timeMs,
          memoryKb: item.memoryKb,
          ...(item.message === undefined ? {} : { message: item.message }),
          ...(item.firstDiffLine === undefined ? {} : { firstDiffLine: item.firstDiffLine }),
        })),
      };
    })
    .filter((item): item is CellDetail => item !== null);

  const names = new Map(contest.contestants.map((item) => [item.id, item.name]));
  for (const detail of details) {
    detail.contestant = names.get(detail.contestant) ?? detail.contestant;
  }

  // 放进 application/json 里而不是直接拼进脚本：这样里面的引号、换行都不需要额外转义，
  // 只要把 '<'（可能构成 </script>）转成 \u003c 就够了。
  const json = JSON.stringify(details).replace(/</g, '\\u003c');
  return [
    `<script type="application/json" id="verdict-details">${json}</script>`,
    '<h2>提交详情</h2>',
    '<p class="hint" id="verdict-hint">点上面的分数单元格查看这一次提交的逐子任务与逐测试点结果。</p>',
    '<div id="verdict-panel"></div>',
    `<script>${SCRIPT}</script>`,
  ].join('\n');
}

function colorOf(ratio: number, theme: ReportTheme): string {
  const scale = THEMES[theme];
  const index = Math.min(scale.length - 1, Math.max(0, Math.ceil(ratio * scale.length) - 1));
  return scale[index] ?? scale[0] ?? '#ffffff';
}

const STYLE = `
:root { color-scheme: light; }
body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 24px; color: #1f2328; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 24px 0 8px; }
.meta { color: #59636e; margin: 0 0 16px; font-size: 13px; }
.hint { color: #59636e; font-size: 13px; }
table { border-collapse: collapse; font-size: 14px; }
th, td { border: 1px solid #d1d9e0; padding: 6px 10px; text-align: center; }
th { background: #f6f8fa; font-weight: 600; }
td.name, th.name { text-align: left; }
td.cell { min-width: 72px; }
td.cell[data-cell] { cursor: pointer; }
td.cell[data-cell]:hover { outline: 2px solid #1f6feb; outline-offset: -2px; }
.score { font-weight: 600; }
.max { font-weight: 400; opacity: 0.75; font-size: 12px; }
.verdict { display: block; font-size: 11px; opacity: 0.85; }
td.total, th.total { font-weight: 700; }
table.detail { margin-top: 4px; }
h3 { font-size: 14px; margin: 16px 0 4px; }
.problem { border: 1px solid #d1d9e0; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; }
.problem h3 { margin-top: 0; }
.problem .meta { margin: 0 0 8px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.meta strong { font-weight: 600; }
`;

const SCRIPT = `
(function () {
  var source = document.getElementById('verdict-details');
  var panel = document.getElementById('verdict-panel');
  var table = document.getElementById('standings');
  if (!source || !panel || !table) { return; }

  // 键必须与 td[data-cell] 上的值一致：那是「选手 id + \\u0000 + 题目 id」，
  // 而 item.contestant 是显示名（alice 显示成 Alice）——两者的区别就是这个 bug 的根源。
  var byCell = {};
  JSON.parse(source.textContent || '[]').forEach(function (item) {
    byCell[item.key] = item;
  });

  function text(value) { return String(value == null ? '' : value); }

  function el(tag, className, value) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (value !== undefined && value !== null && value !== '') { node.textContent = text(value); }
    return node;
  }

  function row(cells) {
    var line = document.createElement('tr');
    cells.forEach(function (item) {
      line.appendChild(el('td', item && item.className ? item.className : null,
        item && item.value !== undefined ? item.value : item));
    });
    return line;
  }

  // 名字不能叫 table：上面那个 table 变量拿着榜单 <table>，同名会把函数覆盖掉，
  // 点单元格时直接抛 "table is not a function"——详情一个字都画不出来。
  function detailTable(headers, rows) {
    var node = el('table', 'detail');
    var head = document.createElement('tr');
    headers.forEach(function (item) {
      var th = el('th', item && item.className ? item.className : null, item && item.label !== undefined ? item.label : item);
      head.appendChild(th);
    });
    var headGroup = document.createElement('thead');
    headGroup.appendChild(head);
    node.appendChild(headGroup);
    var body = document.createElement('tbody');
    rows.forEach(function (item) { body.appendChild(item); });
    node.appendChild(body);
    return node;
  }

  function memory(kb) {
    return kb > 0 ? (kb / 1024).toFixed(1) + 'MB' : 'n/a';
  }

  function render(detail) {
    // 全部用 createElement / textContent 建：说明里带尖括号也只是文字，不会被当成标签。
    while (panel.firstChild) { panel.removeChild(panel.firstChild); }

    var summary = el('p');
    summary.appendChild(el('strong', null, detail.contestant + ' · ' + detail.problem));
    summary.appendChild(document.createTextNode(
      '：' + text(detail.score) + '/' + text(detail.maxScore) + ' 分 ' + text(detail.verdict) +
      (detail.message ? '（' + text(detail.message) + '）' : '') +
      (detail.rejudgeCount ? ' · 已重测 ' + text(detail.rejudgeCount) + ' 次' : '') +
      ' · 提交于 ' + text(detail.time)));
    panel.appendChild(summary);

    if (detail.subtasks && detail.subtasks.length > 0) {
      panel.appendChild(el('h3', null, '子任务'));
      panel.appendChild(detailTable(
        [{ label: '子任务' }, { label: '得分' }, { label: '满分' }, { label: '状态', className: 'name' }],
        detail.subtasks.map(function (item) {
          return row([item.id, item.score, item.maxScore,
            { value: statusText(item.status), className: 'name' }]);
        })));
    }

    if (!detail.cases || detail.cases.length === 0) {
      panel.appendChild(el('p', 'meta', '这次提交没有逐测试点结果（例如编译失败）。'));
      return;
    }

    panel.appendChild(el('h3', null, '逐测试点'));
    panel.appendChild(detailTable(
      [{ label: '测试点' }, { label: '判定' }, { label: '得分' }, { label: '满分' },
       { label: '用时' }, { label: '内存' }, { label: '首个不同行' }, { label: '说明', className: 'name' }],
      detail.cases.map(function (item) {
        return row([
          item.test,
          item.verdict,
          item.score,
          item.points,
          text(item.timeMs) + 'ms',
          memory(item.memoryKb),
          item.firstDiffLine === undefined ? '—' : '第 ' + text(item.firstDiffLine) + ' 行',
          { value: text(item.message) || '—', className: 'name' },
        ]);
      })));
  }

  function statusText(status) {
    if (status === 'full') { return '满分'; }
    if (status === 'partial') { return '部分分'; }
    if (status === 'none') { return '未得分'; }
    if (status === 'skipped') { return '依赖未满足，已跳过'; }
    return text(status);
  }

  table.addEventListener('click', function (event) {
    var cell = event.target.closest('td[data-cell]');
    if (!cell) { return; }
    var detail = byCell[cell.getAttribute('data-cell')];
    if (detail) { render(detail); }
  });
})();
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 属性里的 \u0000 是数据键的分隔符，转义时不能动它，只需要避开引号和尖括号。 */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
