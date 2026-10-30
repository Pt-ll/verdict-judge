import { describe, expect, it } from 'vitest';
import { createComparator, type CompareResult } from '../src/core/compare/compare';
import type { ComparatorConfig } from '../src/core/model';

function cmp(
  config: ComparatorConfig,
  output: Buffer | string,
  answer: Buffer | string,
): Promise<CompareResult> {
  const toBuffer = (value: Buffer | string): Buffer =>
    typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return createComparator(config).compare({
    input: Buffer.alloc(0),
    output: toBuffer(output),
    answer: toBuffer(answer),
  });
}

const DEFAULT_MODE: ComparatorConfig = { mode: 'default' };
const LINE_MODE: ComparatorConfig = { mode: 'line' };

describe('compare/default：按行比较', () => {
  it('完全相同判 AC', async () => {
    expect((await cmp(DEFAULT_MODE, '3\n', '3\n')).verdict).toBe('AC');
  });

  it('忽略行尾空白', async () => {
    expect((await cmp(DEFAULT_MODE, '3  \n', '3\n')).verdict).toBe('AC');
    expect((await cmp(DEFAULT_MODE, '3\t\n', '3\n')).verdict).toBe('AC');
  });

  it('忽略末尾空行', async () => {
    expect((await cmp(DEFAULT_MODE, '3\n\n\n', '3\n')).verdict).toBe('AC');
    expect((await cmp(DEFAULT_MODE, '3\n', '3\n\n')).verdict).toBe('AC');
  });

  it('忽略末尾是否带换行', async () => {
    expect((await cmp(DEFAULT_MODE, '3', '3\n')).verdict).toBe('AC');
  });

  it('CRLF 与 LF 视为相同', async () => {
    expect((await cmp(DEFAULT_MODE, '1\r\n2\r\n', '1\n2\n')).verdict).toBe('AC');
  });

  it('内容不同判 WA', async () => {
    const result = await cmp(DEFAULT_MODE, '4\n', '3\n');
    expect(result.verdict).toBe('WA');
    expect(result.scoreRatio).toBe(0);
    expect(result.detail).toContain('第 1 行不同');
  });

  it('实际输出多一行判 WA', async () => {
    const result = await cmp(DEFAULT_MODE, '3\n4\n', '3\n');
    expect(result.verdict).toBe('WA');
    expect(result.detail).toContain('答案没有这一行');
  });

  it('实际输出少一行判 WA', async () => {
    const result = await cmp(DEFAULT_MODE, '3\n', '3\n4\n');
    expect(result.verdict).toBe('WA');
    expect(result.detail).toContain('实际输出缺少这一行');
  });

  it('空输出与空答案判 AC', async () => {
    expect((await cmp(DEFAULT_MODE, '', '')).verdict).toBe('AC');
    expect((await cmp(DEFAULT_MODE, '\n\n', '')).verdict).toBe('AC');
  });

  it('空输出对非空答案判 WA', async () => {
    expect((await cmp(DEFAULT_MODE, '', '3\n')).verdict).toBe('WA');
  });

  it('行内空白不同判 WA', async () => {
    expect((await cmp(DEFAULT_MODE, '1  2\n', '1 2\n')).verdict).toBe('WA');
  });

  it('行首空白不同判 WA', async () => {
    expect((await cmp(DEFAULT_MODE, ' 3\n', '3\n')).verdict).toBe('WA');
  });

  it('不同的非 UTF-8 字节判 WA（不能解码成同一个替换字符后当作相同）', async () => {
    const result = await cmp(
      DEFAULT_MODE,
      Buffer.from([0xff, 0x0a]),
      Buffer.from([0xfe, 0x0a]),
    );
    expect(result.verdict).toBe('WA');
  });

  it('相同的非 UTF-8 字节判 AC', async () => {
    const result = await cmp(
      DEFAULT_MODE,
      Buffer.from([0xff, 0x0a]),
      Buffer.from([0xff, 0x0a]),
    );
    expect(result.verdict).toBe('AC');
  });
});

describe('compare/line：额外报告首个不同行号', () => {
  it('给出正确的行号', async () => {
    const result = await cmp(LINE_MODE, '1\n2\nx\n4\n', '1\n2\ny\n4\n');
    expect(result.verdict).toBe('WA');
    expect(result.firstDiffLine).toBe(3);
  });

  it('行数不同时行号指向缺失处', async () => {
    const result = await cmp(LINE_MODE, '1\n2\n3\n', '1\n2\n');
    expect(result.firstDiffLine).toBe(3);
  });

  it('AC 时不带行号', async () => {
    expect((await cmp(LINE_MODE, '1\n', '1\n')).firstDiffLine).toBeUndefined();
  });

  it('default 模式同样报行号（WA 后要跳到那一行，这个信息本来就是免费的）', async () => {
    expect((await cmp(DEFAULT_MODE, '1\nx\n', '1\ny\n')).firstDiffLine).toBe(2);
  });
});

describe('compare/real：实数比较', () => {
  const real = (overrides: Partial<ComparatorConfig> = {}): ComparatorConfig => ({
    mode: 'real',
    ...overrides,
  });

  it('整数相同判 AC', async () => {
    expect((await cmp(real(), '42\n', '42\n')).verdict).toBe('AC');
  });

  it('绝对误差之内判 AC', async () => {
    expect((await cmp(real({ absEps: 1e-3 }), '1.0009\n', '1\n')).verdict).toBe('AC');
  });

  it('恰好等于绝对误差判 AC（边界含等号）', async () => {
    expect((await cmp(real({ absEps: 0.5 }), '1.5\n', '1\n')).verdict).toBe('AC');
  });

  it('超出绝对误差判 WA', async () => {
    expect((await cmp(real({ absEps: 0.5 }), '1.51\n', '1\n')).verdict).toBe('WA');
  });

  it('相对误差之内判 AC，即使绝对误差远不够', async () => {
    const result = await cmp(
      real({ absEps: 1e-9, relEps: 1e-6 }),
      '1000000001\n',
      '1000000000\n',
    );
    expect(result.verdict).toBe('AC');
  });

  it('两个误差都超出判 WA', async () => {
    const result = await cmp(
      real({ absEps: 1e-9, relEps: 1e-9 }),
      '1.001\n',
      '1\n',
    );
    expect(result.verdict).toBe('WA');
    expect(result.detail).toContain('第 1 个数值不同');
  });

  it('支持科学计数法', async () => {
    expect((await cmp(real(), '1e3\n', '1000\n')).verdict).toBe('AC');
  });

  it('分隔符是空格还是换行都行', async () => {
    expect((await cmp(real(), '1\n2\n', '1 2\n')).verdict).toBe('AC');
  });

  it('nan 与 nan 视为相等', async () => {
    expect((await cmp(real(), 'nan\n', 'nan\n')).verdict).toBe('AC');
  });

  it('nan 与数值判 WA', async () => {
    expect((await cmp(real(), 'nan\n', '0\n')).verdict).toBe('WA');
  });

  it('同号 inf 视为相等', async () => {
    expect((await cmp(real(), 'inf\n', 'inf\n')).verdict).toBe('AC');
    expect((await cmp(real(), '-inf\n', '-inf\n')).verdict).toBe('AC');
  });

  it('异号 inf 判 WA', async () => {
    expect((await cmp(real(), 'inf\n', '-inf\n')).verdict).toBe('WA');
  });

  it('inf 与有限大数判 WA（不能被当成数值混进误差比较）', async () => {
    expect((await cmp(real(), 'inf\n', '1e308\n')).verdict).toBe('WA');
  });

  it('数值个数不同判 WA', async () => {
    const result = await cmp(real(), '1 2 3\n', '1 2\n');
    expect(result.verdict).toBe('WA');
    expect(result.detail).toContain('数值个数不同');
  });

  it('非数值 token 按原样比较', async () => {
    expect((await cmp(real(), 'abc\n', 'abc\n')).verdict).toBe('AC');
    expect((await cmp(real(), 'abc\n', 'abd\n')).verdict).toBe('WA');
  });

  it('数值与文本 token 判 WA', async () => {
    expect((await cmp(real(), '1\n', 'abc\n')).verdict).toBe('WA');
  });
});

describe('compare：需要外部运行环境的比较方式', () => {
  it('未准备 checker / interactor 时返回 UKE，而不是伪装成判对', async () => {
    const spj = await cmp({ mode: 'spj', spj: 'extra/checker.cpp' }, '1\n', '1\n');
    expect(spj.verdict).toBe('UKE');
    expect(spj.detail).toContain('需要先准备');

    const interactive = await cmp({ mode: 'interactive' }, '1\n', '1\n');
    expect(interactive.verdict).toBe('UKE');
  });
});
