/**
 * 侧边栏面板的 HTML / CSS / 脚本。
 *
 * 与榜单 WebView 同一套安全路线（SPEC §4.7、§4.12）：CSP 是 default-src 'none'，
 * 脚本与样式只认当次 nonce，数据靠 postMessage 注入，DOM 一律用 createElement /
 * textContent 建（不拼 HTML 字符串），所以选手名、文件名里带尖括号也不会出问题。
 * 面板里没有任何网络请求，图表也不用外部库。
 */
export function panelHtml(nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Verdict</title>',
    `<style nonce="${nonce}">${PANEL_STYLE}</style>`,
    '</head>',
    '<body>',
    '<div id="root"><p class="hint">正在读取评测配置…</p></div>',
    `<script nonce="${nonce}">${SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/** 每次解析都用新的 nonce：CSP 因此只认这一份脚本与样式。 */
export function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

export const PANEL_STYLE = `
:root { --gap: 8px; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: 12px;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, transparent);
}
#root { display: flex; flex-direction: column; height: 100vh; }

.top { padding: 8px 10px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
.top .title { font-weight: 600; font-size: 13px; display: flex; align-items: baseline; gap: 6px; }
.top .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
.top .actions { display: flex; gap: 4px; margin-top: 6px; }

.tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
.tabs button {
  flex: 1 1 0;
  background: none;
  border: none;
  border-bottom: 1px solid transparent;
  color: var(--vscode-descriptionForeground);
  font-family: inherit;
  font-size: 12px;
  padding: 6px 2px;
  cursor: pointer;
}
.tabs button:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
.tabs button.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }

.body { flex: 1 1 auto; overflow: auto; padding: 8px; }
.status { flex: none; border-top: 1px solid var(--vscode-panel-border); padding: 4px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.status.busy { color: var(--vscode-foreground); }
.status.error { color: var(--vscode-errorForeground, #f48771); }
.status.warn { color: var(--vscode-editorWarning-foreground, #cca700); }

.banner {
  border: 1px solid var(--vscode-editorError-foreground, #f14c4c);
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 8px;
  color: var(--vscode-errorForeground, #f48771);
  font-size: 11px;
  line-height: 1.6;
}
.banner .row { margin-top: 6px; }

button.btn {
  font-family: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid transparent;
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.17));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  cursor: pointer;
  white-space: nowrap;
}
button.btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.28)); }
button.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button.btn.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
button.btn[disabled] { opacity: 0.5; cursor: default; }
button.icon {
  background: none;
  border: none;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  cursor: pointer;
  padding: 2px 4px;
  font-size: 12px;
  border-radius: 3px;
}
button.icon:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); }

.card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 8px;
}
.card h2 { font-size: 11px; margin: 0 0 4px; color: var(--vscode-descriptionForeground); font-weight: 600; }
.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.kv { display: flex; justify-content: space-between; gap: 8px; line-height: 1.7; }
.kv span:first-child { color: var(--vscode-descriptionForeground); }
.hint { color: var(--vscode-descriptionForeground); line-height: 1.6; margin: 4px 0; }
.mono { font-family: var(--vscode-editor-font-family, monospace); }

.problems { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
.problem {
  text-align: left;
  border: 1px solid transparent;
  border-radius: 3px;
  background: none;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  padding: 4px 6px;
  cursor: pointer;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.problem:hover { background: var(--vscode-list-hoverBackground); }
.problem.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.problem .pid { font-weight: 600; }
.problem .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
.problem.active .meta { color: inherit; opacity: 0.8; }

.group { margin-bottom: 10px; }
.group > header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
  border-radius: 3px;
  font-size: 11px;
}
.group > header .name { font-weight: 600; }
.group > header .meta { color: var(--vscode-descriptionForeground); }
.group > header .spacer { margin-left: auto; }

.case {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  cursor: pointer;
}
.case:hover { background: var(--vscode-list-hoverBackground); }
.case .cid { font-weight: 600; min-width: 26px; }
.case .num { color: var(--vscode-descriptionForeground); font-size: 11px; }
.case .grow { flex: 1 1 auto; }
.case .tools { display: flex; gap: 2px; }

.chip {
  display: inline-block;
  min-width: 30px;
  text-align: center;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--vscode-descriptionForeground);
}
.chip.AC { background: var(--vscode-charts-green, #3fb950); }
.chip.WA, .chip.RE { background: var(--vscode-charts-red, #f14c4c); }
.chip.TLE, .chip.MLE, .chip.OLE { background: var(--vscode-charts-orange, #d18616); }
.chip.CE { background: var(--vscode-charts-purple, #b180d7); }
.chip.PC { background: var(--vscode-charts-blue, #3794ff); }
.chip.none { background: transparent; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); }

.expand { padding: 4px 8px 8px; background: var(--vscode-editor-background, rgba(0,0,0,0.12)); }
.expand h3 { font-size: 10px; margin: 6px 0 2px; color: var(--vscode-descriptionForeground); font-weight: 600; }
pre {
  margin: 0;
  padding: 4px 6px;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  border-radius: 3px;
}
pre.empty { color: var(--vscode-descriptionForeground); }

input, select {
  font-family: inherit;
  font-size: 11px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  padding: 2px 4px;
  min-width: 0;
}
input[type=number] { width: 64px; }
label.field { display: inline-flex; align-items: center; gap: 4px; margin: 2px 8px 2px 0; }
label.field > span { color: var(--vscode-descriptionForeground); }

table { border-collapse: collapse; width: 100%; font-size: 11px; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 4px; text-align: center; }
td.name, th.name { text-align: left; }
td.cell { cursor: pointer; }
td.cell:hover { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.bar { height: 4px; background: var(--vscode-panel-border); border-radius: 2px; margin-top: 4px; overflow: hidden; }
.bar > div { height: 100%; background: var(--vscode-charts-green, #3fb950); }
`;

// 这段脚本会原样进 HTML，所以不写反引号、不写 ${}。
const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('root');
  var state = null;
  var tab = 'tests';
  var expanded = {};
  var limitDraft = null;
  var comparatorDraft = null;
  var subtaskDraft = null;
  var cellDetail = null;
  var busy = null;
  var notice = null;

  function post(message) { vscode.postMessage(message); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  function button(label, title, onClick, className) {
    var node = el('button', className ? 'btn ' + className : 'btn', label);
    if (title) { node.title = title; }
    node.addEventListener('click', onClick);
    return node;
  }

  function iconButton(label, title, onClick) {
    var node = el('button', 'icon', label);
    node.title = title;
    node.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick();
    });
    return node;
  }

  function fmtMemory(kb) {
    if (kb === null || kb === undefined || kb <= 0) { return '—'; }
    return (kb / 1024).toFixed(1) + 'MB';
  }

  function fmtTime(ms) {
    return (ms === null || ms === undefined) ? '—' : ms + 'ms';
  }

  function chip(verdict) {
    if (!verdict) { return el('span', 'chip none', '—'); }
    return el('span', 'chip ' + verdict, verdict);
  }

  function pre(text, emptyText) {
    if (!text) { return el('pre', 'empty', emptyText); }
    return el('pre', null, text);
  }

  function renderTop() {
    var box = el('div', 'top');
    var selected = state.selected;
    var line = el('div', 'title');
    line.appendChild(el('span', null,
      selected === null ? 'Verdict 本地评测' : selected.id + ' · ' + selected.name));
    box.appendChild(line);

    var sub = el('div', 'sub');
    if (state.contest) {
      sub.textContent = state.contest.title + ' · ' + state.contest.contestants.length + ' 名选手';
    } else if (state.problems.length > 0) {
      sub.textContent = '未配置比赛 · ' + state.problems.length + ' 道题';
    } else {
      sub.textContent = '还没有题目';
    }
    box.appendChild(sub);

    var source = el('div', 'sub');
    if (!state.source) {
      source.textContent = '源码：未打开（先打开 .cpp / .py 再评测）';
    } else {
      source.textContent = '源码：' + state.source.name + (state.source.dirty ? '（未保存）' : '');
    }
    box.appendChild(source);

    var actions = el('div', 'actions');
    var canJudge = state.source !== null && state.source.judgeable && selected !== null;
    var judge = button('▶ 评测', '用当前源码跑这道题的全部测试点', function () {
      post({ type: 'judge' });
    }, 'primary');
    judge.disabled = !canJudge;
    actions.appendChild(judge);

    var debug = button('🐞 调试', '用第一个测试点的输入起调试会话', function () {
      post({ type: 'debug' });
    });
    debug.disabled = !canJudge;
    actions.appendChild(debug);

    if (busy) {
      actions.appendChild(button('■ 取消', '中止当前评测', function () {
        post({ type: 'cancel' });
      }));
    } else {
      actions.appendChild(button('⟳', '刷新面板', function () { post({ type: 'refresh' }); }));
    }
    box.appendChild(actions);
    return box;
  }

  function renderTabs() {
    var box = el('nav', 'tabs');
    [['problems', '题目'], ['tests', '测试点'], ['standings', '榜单']].forEach(function (item) {
      var node = el('button', tab === item[0] ? 'active' : null, item[1]);
      node.addEventListener('click', function () {
        tab = item[0];
        render();
      });
      box.appendChild(node);
    });
    return box;
  }
  function renderProblemList() {
    var box = el('div', 'problems');
    state.problems.forEach(function (problem) {
      var active = state.selected !== null && state.selected.id === problem.id;
      var node = el('button', 'problem' + (active ? ' active' : ''));
      node.appendChild(el('span', 'pid', problem.id));
      node.appendChild(el('span', null, problem.name));
      node.appendChild(el('span', 'meta', problem.broken
        ? '读不出来'
        : (problem.inContest ? '★ ' : '') + problem.testCount + ' 点 · 满分 ' + problem.maxScore));
      if (problem.broken) { node.title = problem.broken; }
      node.addEventListener('click', function () {
        post({ type: 'selectProblem', problemId: problem.id });
      });
      var tools = el('span', 'tools');
      if (state.contest) {
        if (problem.inContest) {
          tools.appendChild(iconButton('−', '从当前比赛移除（题目包与数据都保留）', function () {
            post({ type: 'command', command: 'verdict.removeProblemFromContest', arg: problem.id });
          }));
        } else {
          tools.appendChild(iconButton('＋', '把这道题加进当前比赛', function () {
            post({ type: 'command', command: 'verdict.addProblemToContest', arg: problem.id });
          }));
        }
      }
      tools.appendChild(iconButton('🗑', '删除这道题（可选是否连数据一起删）', function () {
        post({ type: 'command', command: 'verdict.deleteProblem', arg: problem.id });
      }));
      node.appendChild(tools);
      box.appendChild(node);
    });
    return box;
  }

  function renderLimitsCard(problem) {
    var card = el('div', 'card');
    var head = el('div', 'row between');
    head.appendChild(el('h2', null, '限制'));
    head.appendChild(button(limitDraft ? '取消' : '编辑', '时间 / 内存 / 栈 / 输出上限', function () {
      limitDraft = limitDraft ? null : {
        timeMs: problem.limits.timeMs,
        memoryMb: problem.limits.memoryMb,
        stackMb: problem.limits.stackMb,
        outputKb: problem.limits.outputKb
      };
      render();
    }));
    card.appendChild(head);

    if (!limitDraft) {
      [['时间', problem.limits.timeMs + ' ms'],
       ['内存', problem.limits.memoryMb + ' MB'],
       ['栈上限', problem.limits.stackMb + ' MB'],
       ['输出上限', problem.limits.outputKb + ' KB']].forEach(function (item) {
        var line = el('div', 'kv');
        line.appendChild(el('span', null, item[0]));
        line.appendChild(el('span', 'mono', item[1]));
        card.appendChild(line);
      });
      return card;
    }

    var row = el('div', 'row');
    [['timeMs', '时间 ms'], ['memoryMb', '内存 MB'],
     ['stackMb', '栈 MB'], ['outputKb', '输出 KB']].forEach(function (item) {
      var label = el('label', 'field');
      label.appendChild(el('span', null, item[1]));
      var input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.value = String(limitDraft[item[0]]);
      input.addEventListener('input', function () {
        limitDraft[item[0]] = Number(input.value);
      });
      label.appendChild(input);
      row.appendChild(label);
    });
    card.appendChild(row);
    var actions = el('div', 'row');
    actions.appendChild(button('保存', '写回 problem.json', function () {
      post({ type: 'setLimits', limits: limitDraft });
    }, 'primary'));
    card.appendChild(actions);
    return card;
  }

  function comparatorText(config) {
    if (config.mode === 'real') {
      return 'real · 绝对 ' + (config.absEps === undefined ? '1e-6' : config.absEps) +
        ' / 相对 ' + (config.relEps === undefined ? '1e-6' : config.relEps);
    }
    if (config.mode === 'spj') { return 'testlib SPJ · ' + (config.spj || '（未指定 checker）'); }
    if (config.mode === 'interactive') {
      return '交互题 · ' + (config.interactor || '（未指定 interactor）');
    }
    return config.mode === 'line' ? 'line（报告首个不同行）' : 'default（忽略行尾空白）';
  }

  function renderComparatorCard(problem) {
    var card = el('div', 'card');
    var head = el('div', 'row between');
    head.appendChild(el('h2', null, '比较方式'));
    head.appendChild(button(comparatorDraft ? '取消' : '切换', '换一种比较方式', function () {
      comparatorDraft = comparatorDraft ? null : {
        mode: problem.comparator.mode,
        absEps: problem.comparator.absEps,
        relEps: problem.comparator.relEps,
        spj: problem.comparator.spj,
        interactor: problem.comparator.interactor
      };
      render();
    }));
    card.appendChild(head);
    card.appendChild(el('div', 'hint', comparatorText(problem.comparator)));

    if (!comparatorDraft) { return card; }

    var row = el('div', 'row');
    var select = document.createElement('select');
    [['default', '默认（忽略行尾空白）'], ['line', '逐行（报告首个不同行）'],
     ['real', '实数（绝对/相对误差）'], ['spj', 'testlib SPJ'], ['interactive', '交互题']]
      .forEach(function (item) {
        var option = document.createElement('option');
        option.value = item[0];
        option.textContent = item[1];
        if (comparatorDraft.mode === item[0]) { option.selected = true; }
        select.appendChild(option);
      });
    select.addEventListener('change', function () { comparatorDraft.mode = select.value; render(); });
    row.appendChild(select);
    card.appendChild(row);

    if (comparatorDraft.mode === 'real') {
      var epsRow = el('div', 'row');
      [['absEps', '绝对误差'], ['relEps', '相对误差']].forEach(function (item) {
        var label = el('label', 'field');
        label.appendChild(el('span', null, item[1]));
        var input = document.createElement('input');
        input.type = 'text';
        input.value = String(comparatorDraft[item[0]] === undefined ? 1e-6 : comparatorDraft[item[0]]);
        input.addEventListener('input', function () {
          comparatorDraft[item[0]] = Number(input.value);
        });
        label.appendChild(input);
        epsRow.appendChild(label);
      });
      card.appendChild(epsRow);
    }

    if (comparatorDraft.mode === 'spj' || comparatorDraft.mode === 'interactive') {
      var key = comparatorDraft.mode === 'spj' ? 'spj' : 'interactor';
      var fileRow = el('div', 'row');
      fileRow.appendChild(el('span', 'mono', comparatorDraft[key] || '（未指定文件）'));
      fileRow.appendChild(button('选择文件…', '指向 extra/ 里的源码或可执行文件', function () {
        post({ type: 'pickComparatorFile', mode: comparatorDraft.mode });
      }));
      card.appendChild(fileRow);
    }

    var actions = el('div', 'row');
    actions.appendChild(button('保存', '写回 problem.json', function () {
      post({ type: 'setComparator', config: comparatorDraft });
    }, 'primary'));
    card.appendChild(actions);
    return card;
  }

  function renderProblemsTab() {
    var box = el('div');

    var contestCard = el('div', 'card');
    contestCard.appendChild(el('h2', null, '比赛'));
    if (state.contest) {
      // 多场比赛：下拉框切一场，面板里的题目、测试点、榜单都跟着换（SPEC §6.2）。
      var picker = el('div', 'row');
      var select = document.createElement('select');
      select.style.flex = '1 1 auto';
      state.contest.all.forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.title + (item.title === item.id ? '' : '（' + item.id + '）') +
          (item.legacy ? ' · contest.json' : '');
        if (item.active) { option.selected = true; }
        select.appendChild(option);
      });
      select.addEventListener('change', function () {
        post({ type: 'selectContest', contestId: select.value });
      });
      picker.appendChild(select);
      picker.appendChild(button('＋', '再开一场比赛（题目可以重复用）', function () {
        post({ type: 'command', command: 'verdict.newContest' });
      }));
      contestCard.appendChild(picker);

      var line = el('div', 'kv');
      line.appendChild(el('span', null, state.contest.title));
      line.appendChild(el('span', 'mono', state.contest.id));
      contestCard.appendChild(line);
      var autoCount = state.contest.contestants.filter(function (item) { return item.auto; }).length;
      contestCard.appendChild(el('div', 'hint',
        state.contest.contestants.length + ' 名选手' +
        (autoCount > 0 ? '（其中 ' + autoCount + ' 名来自 players/ 自动发现）' : '') +
        ' · 重测上限 ' + state.contest.maxRejudge + ' 次 · 题目 ' +
        state.contest.problemIds.length + ' 道'));
      contestCard.appendChild(el('div', 'hint', '题目配置 ' + state.contest.problemsDir +
        ' · 测试数据 ' + state.contest.dataDir));
      if (state.contest.error) {
        contestCard.appendChild(el('div', 'hint', '比赛配置读不出来：' + state.contest.error));
      }
    } else {
      contestCard.appendChild(el('div', 'hint',
        '还没有比赛：新建一个才能评测全部与出榜。一个工作区可以放好几场比赛，题目可以重复用。'));
      var contestRow = el('div', 'row');
      contestRow.appendChild(button('＋ 新建比赛', null, function () {
        post({ type: 'command', command: 'verdict.newContest' });
      }, 'primary'));
      contestCard.appendChild(contestRow);
    }
    box.appendChild(contestCard);

    var listCard = el('div', 'card');
    listCard.appendChild(el('h2', null, '题目'));
    if (state.problems.length === 0) {
      listCard.appendChild(el('div', 'hint',
        '还没有题目。新建一道题，或者把别人给的题目包导进来——不用手写 JSON。'));
    } else {
      listCard.appendChild(renderProblemList());
    }
    var tools = el('div', 'row');
    tools.appendChild(button('＋ 新建题目', null, function () {
      post({ type: 'command', command: 'verdict.newProblem' });
    }, 'primary'));
    tools.appendChild(button('导入题目包…', null, function () {
      post({ type: 'command', command: 'verdict.importProblem' });
    }));
    var exportButton = button('导出题目包…', null, function () {
      post({ type: 'command', command: 'verdict.exportProblem' });
    });
    exportButton.disabled = state.selected === null;
    tools.appendChild(exportButton);
    var deleteButton = button('删除题目…', '题目包可选是否连数据一起删', function () {
      post({
        type: 'command',
        command: 'verdict.deleteProblem',
        arg: state.selected === null ? undefined : state.selected.id
      });
    });
    deleteButton.disabled = state.selected === null;
    tools.appendChild(deleteButton);
    listCard.appendChild(tools);
    box.appendChild(listCard);

    if (state.selected) {
      box.appendChild(renderLimitsCard(state.selected));
      box.appendChild(renderComparatorCard(state.selected));
      var linkRow = el('div', 'row');
      linkRow.appendChild(button('打开 problem.json', '想手改的话，JSON 就是唯一的存储', function () {
        post({ type: 'openProblemJson' });
      }));
      box.appendChild(linkRow);
    } else {
      var broken = state.problems.filter(function (item) { return item.broken; })[0];
      if (broken) { box.appendChild(el('div', 'hint', '题目包读不出来：' + broken.broken)); }
    }
    return box;
  }
  function renderCaseRow(test, allSubtasks) {
    var wrap = el('div');
    var row = el('div', 'case');
    row.appendChild(el('span', 'cid', '#' + test.id));
    row.appendChild(chip(test.verdict));
    row.appendChild(el('span', 'num', fmtTime(test.timeMs)));
    row.appendChild(el('span', 'num', fmtMemory(test.memoryKb)));
    row.appendChild(el('span', 'grow'));

    var tools = el('div', 'tools');
    tools.appendChild(iconButton('▶', '只用这个输入跑一次', function () {
      post({ type: 'judgeCase', testId: test.id });
    }));
    tools.appendChild(iconButton('🐞', '用这个输入起调试会话', function () {
      post({ type: 'debugCase', testId: test.id });
    }));
    if (test.verdict === 'WA' || test.verdict === 'PC') {
      tools.appendChild(iconButton('⇄', '对比实际输出与标准答案', function () {
        post({ type: 'openDiff', testId: test.id });
      }));
    }
    tools.appendChild(iconButton(expanded[test.id] ? '▾' : '▸', '展开输入 / 期望 / 实际输出', function () {
      expanded[test.id] = !expanded[test.id];
      render();
    }));
    row.appendChild(tools);
    row.addEventListener('click', function () {
      expanded[test.id] = !expanded[test.id];
      render();
    });
    wrap.appendChild(row);

    if (!expanded[test.id]) { return wrap; }

    var box = el('div', 'expand');
    if (test.message) { box.appendChild(el('div', 'hint', test.message)); }
    box.appendChild(el('h3', null, '输入 · ' + test.input));
    box.appendChild(pre(test.inputText, '（读不到文件）'));
    box.appendChild(el('h3', null, '标准答案 · ' + test.answer));
    box.appendChild(pre(test.expectedText, '（读不到文件）'));
    box.appendChild(el('h3', null, '实际输出'));
    box.appendChild(pre(test.outputText, '（还没跑过这个点）'));

    var move = el('div', 'row');
    move.appendChild(el('span', 'num', '归属'));
    var select = document.createElement('select');
    var none = document.createElement('option');
    none.value = '';
    none.textContent = '（不计入子任务）';
    if (!test.subtask) { none.selected = true; }
    select.appendChild(none);
    allSubtasks.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.id;
      option.textContent = '子任务 ' + item.id;
      if (test.subtask === item.id) { option.selected = true; }
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      post({ type: 'moveTest', testId: test.id, subtaskId: select.value || null });
    });
    move.appendChild(select);
    move.appendChild(button('移出登记', '只取消登记，data/ 里的文件不动', function () {
      post({ type: 'removeTest', testId: test.id });
    }));
    var openInput = button('打开输入', null, function () {
      post({ type: 'openCaseFile', testId: test.id, kind: 'input' });
    });
    openInput.disabled = !test.hasData;
    move.appendChild(openInput);
    move.appendChild(button('打开答案', null, function () {
      post({ type: 'openCaseFile', testId: test.id, kind: 'answer' });
    }));
    box.appendChild(move);
    wrap.appendChild(box);
    return wrap;
  }

  function renderGroup(title, meta, tests, subtask, allSubtasks) {
    var group = el('div', 'group');
    var head = el('header');
    head.appendChild(el('span', 'name', title));
    head.appendChild(el('span', 'meta', meta));
    head.appendChild(el('span', 'spacer'));
    if (subtask) {
      head.appendChild(iconButton('✎', '改分值 / 依赖 / 计分方式', function () {
        subtaskDraft = subtaskDraft !== null && subtaskDraft.id === subtask.id ? null : {
          id: subtask.id,
          name: subtask.name,
          points: subtask.points,
          dependsOn: subtask.dependsOn.join(','),
          scoring: subtask.scoring
        };
        render();
      }));
      head.appendChild(iconButton('✕', '删除子任务（测试点保留）', function () {
        post({ type: 'removeSubtask', subtaskId: subtask.id });
      }));
    }
    group.appendChild(head);

    if (subtask && subtaskDraft !== null && subtaskDraft.id === subtask.id) {
      var editor = el('div', 'expand');
      var row = el('div', 'row');
      var points = el('label', 'field');
      points.appendChild(el('span', null, '分值'));
      var pointsInput = document.createElement('input');
      pointsInput.type = 'number';
      pointsInput.min = '0';
      pointsInput.value = String(subtaskDraft.points);
      pointsInput.addEventListener('input', function () {
        subtaskDraft.points = Number(pointsInput.value);
      });
      points.appendChild(pointsInput);
      row.appendChild(points);

      var scoring = el('label', 'field');
      scoring.appendChild(el('span', null, '计分'));
      var scoringSelect = document.createElement('select');
      [['min', '组内全对才给分'], ['sum', '按测试点求和']].forEach(function (item) {
        var option = document.createElement('option');
        option.value = item[0];
        option.textContent = item[1];
        if (subtaskDraft.scoring === item[0]) { option.selected = true; }
        scoringSelect.appendChild(option);
      });
      scoringSelect.addEventListener('change', function () {
        subtaskDraft.scoring = scoringSelect.value;
      });
      scoring.appendChild(scoringSelect);
      row.appendChild(scoring);
      editor.appendChild(row);

      var depRow = el('div', 'row');
      depRow.appendChild(el('span', 'num', '依赖的子任务'));
      var depInput = document.createElement('input');
      depInput.type = 'text';
      depInput.placeholder = '例如 1,2';
      depInput.value = subtaskDraft.dependsOn;
      depInput.style.flex = '1 1 auto';
      depInput.addEventListener('input', function () {
        subtaskDraft.dependsOn = depInput.value;
      });
      depRow.appendChild(depInput);
      editor.appendChild(depRow);

      var actions = el('div', 'row');
      actions.appendChild(button('保存', null, function () {
        post({
          type: 'updateSubtask',
          subtaskId: subtaskDraft.id,
          patch: {
            name: subtaskDraft.name,
            points: subtaskDraft.points,
            scoring: subtaskDraft.scoring,
            dependsOn: subtaskDraft.dependsOn
              .split(',')
              .map(function (item) { return item.trim(); })
              .filter(function (item) { return item.length > 0; })
          }
        });
      }, 'primary'));
      actions.appendChild(button('取消', null, function () {
        subtaskDraft = null;
        render();
      }));
      editor.appendChild(actions);
      group.appendChild(editor);
    }

    tests.forEach(function (test) { group.appendChild(renderCaseRow(test, allSubtasks)); });
    return group;
  }

  function renderTestsTab() {
    var box = el('div');
    var problem = state.selected;
    if (!problem) {
      var brokenProblem = state.problems.filter(function (item) { return item.broken; })[0];
      box.appendChild(el('p', 'hint', brokenProblem
        ? '题目包读不出来：' + brokenProblem.broken
        : '先在「题目」里选一道题（或新建一道）。'));
      return box;
    }

    var summary = el('div', 'card');
    var head = el('div', 'row between');
    head.appendChild(el('span', 'mono', problem.id + ' · 满分 ' + problem.maxScore));
    if (!problem.partial) {
      head.appendChild(el('span', 'mono', '得分 ' + problem.score + ' / ' + problem.maxScore));
    }
    summary.appendChild(head);
    if (problem.partial) {
      // 只跑了一部分点时**不能**显示总分：子任务计分是整套数据算出来的，
      // 单跑一个点往往让依赖它的子任务全变成 0，那个数字会把人吓一跳（也不对）。
      summary.appendChild(el('div', 'hint',
        '这一轮只跑了一部分测试点，分数不完整。点「评测整题」看完整得分。'));
    } else {
      var bar = el('div', 'bar');
      var fill = el('div');
      var ratio = problem.maxScore > 0
        ? Math.max(0, Math.min(1, problem.score / problem.maxScore))
        : 0;
      fill.style.width = (ratio * 100).toFixed(0) + '%';
      bar.appendChild(fill);
      summary.appendChild(bar);
    }
    box.appendChild(summary);

    if (problem.tests.length === 0) {
      box.appendChild(el('p', 'hint',
        '还没有测试点：把 1.in / 1.out 放进 ' + problem.dataDir +
        '，再点下面的「扫描新测试点」。'));
    }

    var byId = {};
    problem.tests.forEach(function (test) { byId[test.id] = test; });
    problem.subtasks.forEach(function (subtask) {
      var tests = subtask.tests
        .map(function (id) { return byId[id]; })
        .filter(function (test) { return test !== undefined; });
      var meta = subtask.points + ' 分 · 依赖 ' +
        (subtask.dependsOn.length === 0 ? '无' : subtask.dependsOn.join('、')) +
        ' · ' + (subtask.scoring === 'min' ? '组内全对才给分' : '按点求和');
      if (subtask.result) { meta += ' · 得 ' + subtask.result.score + ' 分'; }
      box.appendChild(renderGroup(subtask.name, meta, tests, subtask, problem.subtasks));
    });

    if (problem.orphanTests.length > 0) {
      var orphans = problem.orphanTests
        .map(function (id) { return byId[id]; })
        .filter(function (test) { return test !== undefined; });
      box.appendChild(renderGroup('未归入子任务', '这些点直接计入总分', orphans, null, problem.subtasks));
    }

    var tools = el('div', 'row');
    tools.appendChild(button('扫描新测试点', '把 data/ 里还没登记的数据加进来', function () {
      post({ type: 'scanTests' });
    }, 'primary'));
    tools.appendChild(button('＋ 子任务', null, function () { post({ type: 'addSubtask' }); }));
    tools.appendChild(button('按点均分', null, function () { post({ type: 'evenSubtasks' }); }));
    tools.appendChild(button('清空子任务', null, function () { post({ type: 'clearSubtasks' }); }));
    box.appendChild(tools);

    var row2 = el('div', 'row');
    row2.appendChild(button('▶ 评测整题', null, function () { post({ type: 'judge' }); }, 'primary'));
    row2.appendChild(button('打开数据目录', null, function () { post({ type: 'openDataDir' }); }));
    box.appendChild(row2);
    return box;
  }
  function renderStandingsTab() {
    var box = el('div');
    if (!state.contest) {
      box.appendChild(el('p', 'hint',
        '还没有比赛。在「题目」里新建一个比赛，再把选手源码放进 players/ 下。'));
      return box;
    }

    var tools = el('div', 'row');
    tools.appendChild(button('▶ 评测全部', '跑所有选手 × 所有题目', function () {
      post({ type: 'command', command: 'verdict.judgeAll' });
    }, 'primary'));
    tools.appendChild(button('导出 HTML…', null, function () {
      post({ type: 'command', command: 'verdict.exportHtml' });
    }));
    tools.appendChild(button('完整榜单', '在编辑器里打开大表格与统计', function () {
      post({ type: 'command', command: 'verdict.showStandings' });
    }));
    box.appendChild(tools);

    var standings = state.standings;
    if (!standings) {
      box.appendChild(el('p', 'hint', '比赛配置读不出来，先把比赛配置与题目包修好。'));
      return box;
    }
    var autoPlayers = state.contest.contestants.filter(function (item) { return item.auto; }).length;
    if (autoPlayers > 0) {
      box.appendChild(el('p', 'hint',
        '其中 ' + autoPlayers + ' 名选手是从 players/ 自动发现的（放进去就算，不用改比赛配置）。'));
    }
    if (standings.ranks.length === 0) {
      box.appendChild(el('p', 'hint', '这场比赛还没有选手。'));
      return box;
    }

    var table = el('table');
    var head = el('tr');
    head.appendChild(el('th', null, '#'));
    head.appendChild(el('th', 'name', '选手'));
    standings.problems.forEach(function (problem) {
      head.appendChild(el('th', null, problem.id));
    });
    head.appendChild(el('th', null, '总分'));
    table.appendChild(head);

    standings.ranks.forEach(function (rank) {
      var row = el('tr');
      row.appendChild(el('td', null, rank.rank));
      var me = standings.contestants.filter(function (item) {
        return item.id === rank.contestant;
      })[0];
      row.appendChild(el('td', 'name', me ? me.name : rank.contestant));
      standings.problems.forEach(function (problem) {
        var cell = standings.cells.filter(function (item) {
          return item.contestant === rank.contestant && item.problem === problem.id;
        })[0];
        var td = el('td', 'cell', cell ? cell.score : '—');
        td.title = cell
          ? (cell.verdict || '?') + ' · 重测 ' + cell.rejudgeCount + ' 次（点一下看详情 / 重测）'
          : '还没有提交';
        td.addEventListener('click', function () {
          cellDetail = { contestant: rank.contestant, problem: problem.id };
          render();
        });
        row.appendChild(td);
      });
      row.appendChild(el('td', null, rank.score));
      table.appendChild(row);
    });
    box.appendChild(table);

    if (cellDetail) {
      var cellNow = standings.cells.filter(function (item) {
        return item.contestant === cellDetail.contestant && item.problem === cellDetail.problem;
      })[0];
      var detail = el('div', 'card');
      detail.appendChild(el('h2', null, cellDetail.contestant + ' × ' + cellDetail.problem));
      detail.appendChild(el('div', 'hint', cellNow
        ? (cellNow.verdict || '?') + ' · ' + cellNow.score + ' 分 · 已重测 ' + cellNow.rejudgeCount +
          ' 次（上限 ' + state.contest.maxRejudge + '）'
        : '这一格还没有提交，先「评测全部」。'));
      var detailRow = el('div', 'row');
      var rejudge = button('重测这一格', null, function () {
        post({ type: 'rejudge', contestant: cellDetail.contestant, problem: cellDetail.problem });
      }, 'primary');
      rejudge.disabled = !cellNow;
      detailRow.appendChild(rejudge);
      detailRow.appendChild(button('关闭', null, function () {
        cellDetail = null;
        render();
      }));
      detail.appendChild(detailRow);
      box.appendChild(detail);
    }
    return box;
  }

  function renderStatus() {
    var box = el('div', 'status' + (busy ? ' busy' : (notice ? ' ' + notice.level : '')));
    if (busy) {
      box.textContent = '⏳ ' + busy;
    } else if (notice) {
      box.textContent = notice.text;
    } else {
      box.textContent = '就绪';
    }
    return box;
  }

  /** 出错了就把话说在明处：以前只在底部那行小字里，面板一旦没数据就是「一片空白」。 */
  function renderBanner() {
    var text = state.contest && state.contest.error
      ? '比赛配置读不出来：' + state.contest.error
      : (notice && notice.level === 'error' ? notice.text : '');
    if (!text) { return null; }
    var box = el('div', 'banner');
    box.appendChild(el('div', null, text));
    var row = el('div', 'row');
    row.appendChild(button('重新读取', '再读一遍工作区里的配置', function () {
      post({ type: 'refresh' });
    }));
    if (state.contest && state.contest.error) {
      row.appendChild(button('打开比赛配置', null, function () {
        post({ type: 'openContestJson' });
      }));
    }
    box.appendChild(row);
    return box;
  }

  function render() {
    clear(root);
    if (!state) { return; }
    root.appendChild(renderTop());
    root.appendChild(renderTabs());
    var body = el('div', 'body');
    var banner = renderBanner();
    if (banner) { body.appendChild(banner); }
    if (tab === 'problems') { body.appendChild(renderProblemsTab()); }
    else if (tab === 'tests') { body.appendChild(renderTestsTab()); }
    else { body.appendChild(renderStandingsTab()); }
    root.appendChild(body);
    root.appendChild(renderStatus());
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') { return; }
    if (message.type === 'data') {
      state = message.payload;
      busy = state.busy;
      notice = state.notice;
      if (state.selected === null) { limitDraft = null; comparatorDraft = null; subtaskDraft = null; }
      if (state.selected !== null && comparatorDraft !== null &&
          comparatorDraft.mode !== state.selected.comparator.mode) {
        comparatorDraft = null;
      }
      render();
    } else if (message.type === 'busy') {
      busy = message.text;
      if (message.text) { notice = null; }
      render();
    } else if (message.type === 'notice') {
      busy = null;
      notice = { level: message.level || 'info', text: message.text };
      render();
    } else if (message.type === 'filePicked') {
      // 「选择文件…」只把路径填回还没保存的表单，改不改由用户按「保存」决定。
      if (comparatorDraft) {
        comparatorDraft[message.key] = message.path;
        render();
      }
    }
  });

  post({ type: 'ready' });
})();
`;
