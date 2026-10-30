import type { ComparatorConfig } from '../model';
import { compareLines } from './default';
import { compareReal } from './real';

export interface ComparatorInput {
  input: Buffer;
  output: Buffer;
  answer: Buffer;
}

export interface CompareResult {
  /**
   * SPEC 只定义了 AC / WA / PC；这里额外允许 UKE，表示比较器没有准备好或评测方出错。
   */
  verdict: 'AC' | 'WA' | 'PC' | 'UKE';
  /** 0..1，spj 可给部分分；AC 为 1，WA 为 0。 */
  scoreRatio: number;
  detail: string;
  /** 逐行模式下首个不同行（1 起）；其余模式为 undefined。 */
  firstDiffLine?: number;
}

export interface Comparator {
  readonly config: ComparatorConfig;
  compare(input: ComparatorInput): Promise<CompareResult>;
}

/**
 * 按配置创建比较器。
 *
 * spj / interactive 需要题目包路径、编译器与沙箱，必须先走 prepareComparator；
 * 这个纯函数工厂拿不到那些上下文，所以返回明确的 UKE，不能悄悄退化成 default。
 */
export function createComparator(config: ComparatorConfig): Comparator {
  switch (config.mode) {
    case 'default':
    case 'line':
      return {
        config,
        compare: async (input) => compareLines(input),
      };
    case 'real':
      return { config, compare: async (input) => compareReal(input, config) };
    default:
      return {
        config,
        compare: async () => ({
          verdict: 'UKE',
          scoreRatio: 0,
          detail: `比较方式 ${config.mode} 需要先准备 checker / interactor 运行环境`,
        }),
      };
  }
}
