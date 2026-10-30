import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile, detectToolchain, type Toolchain } from '../src/core/compiler';
import { DEFAULT_LIMITS, type CancellationTokenLike, type Limits } from '../src/core/model';
import { createPosixHooks } from '../src/core/sandbox/posix';
import { createSandbox, type RunCommand } from '../src/core/sandbox/sandbox';
import { createWindowsHooks } from '../src/core/sandbox/windows';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-sandbox-'));
const cacheDir = path.join(workDir, 'cache');
const sandbox = createSandbox();

let toolchain: Toolchain | null = null;
let memorySamplingAvailable = false;

beforeAll(async () => {
  toolchain = await detectToolchain();
  const hooks = process.platform === 'win32' ? createWindowsHooks() : createPosixHooks();
  const memoryKb = await hooks.memoryKb(process.pid);
  memorySamplingAvailable = memoryKb !== null && memoryKb > 0;
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** 编译一段测试程序；本机没有 C++ 编译器时返回 null，调用方直接跳过。 */
async function build(name: string, source: string): Promise<RunCommand | null> {
  if (!toolchain || toolchain.kind === 'python') {
    return null;
  }
  const sourcePath = path.join(workDir, `${name}.cpp`);
  fs.writeFileSync(sourcePath, source);
  const result = await compile(toolchain, sourcePath, {
    cacheDir,
    flags: ['-O2', '-std=c++17'],
  });
  if (!result.ok) {
    throw new Error(
      `编译 ${name} 失败：${result.diagnostics.map((d) => d.raw).join(' | ')}`,
    );
  }
  return result.runCmd;
}

function limits(overrides: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

const INFINITE_LOOP = 'int main() { for (;;) {} }\n';

const ECHO_SUM = [
  '#include <cstdio>',
  'int main() {',
  '  int a = 0, b = 0;',
  '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
  '  std::printf("%d\\n", a + b);',
  '  return 0;',
  '}',
  '',
].join('\n');

// 与 ECHO_SUM 输出相同，但算完之后空转到 200ms 才退出。
//
// 内存是 25ms 轮询采样的（SPEC §8.3），一个几毫秒就跑完的程序可能一次都采不到：
// 首次执行新写的二进制时，进程大部分时间耗在内核校验里，那期间 ps 读出来的 RSS 是 0。
// 于是 peakMemKb 合法地等于 0，而断言要求 > 0——这条用例在 macOS CI 上就是这么红的。
// 让程序多活一会儿，断言测的才是「采样能不能拿到数」，而不是「机器够不够快」。
const ECHO_SUM_ALIVE = [
  '#include <cstdio>',
  '#include <chrono>',
  'int main() {',
  '  int a = 0, b = 0;',
  '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
  '  std::printf("%d\\n", a + b);',
  '  const auto deadline =',
  '      std::chrono::steady_clock::now() + std::chrono::milliseconds(200);',
  '  while (std::chrono::steady_clock::now() < deadline) {}',
  '  return 0;',
  '}',
  '',
].join('\n');

const ABORT_PROGRAM = '#include <cstdlib>\nint main() { std::abort(); }\n';

const MEMORY_HOG = [
  '#include <cstdlib>',
  '#include <cstring>',
  '#include <vector>',
  'int main() {',
  '  std::vector<char*> blocks;',
  '  for (;;) {',
  '    char* p = static_cast<char*>(std::malloc(4 << 20));',
  '    if (p == nullptr) return 3;',
  '    std::memset(p, 1, 4 << 20);',
  '    blocks.push_back(p);',
  '    // 放慢分配节奏，让 25ms 的内存采样来得及发现超限',
  '    for (volatile long i = 0; i < 3000000; ++i) {}',
  '  }',
  '}',
  '',
].join('\n');

const OUTPUT_SPAM = [
  '#include <cstdio>',
  'int main() {',
  '  const char block[4096] = {};',
  '  for (;;) std::fwrite(block, 1, sizeof block, stdout);',
  '}',
  '',
].join('\n');

describe('sandbox：正常执行', () => {
  it(
    '读 stdin、写 stdout，判 OK 并给出耗时与内存',
    async () => {
      const run = await build('ok-alive', ECHO_SUM_ALIVE);
      if (!run) {
        return;
      }
      const result = await sandbox.run(run, Buffer.from('1 2\n'), limits({ timeMs: 5000 }));

      expect(result.status).toBe('OK');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe('3');
      expect(result.truncated).toBe(false);
      expect(result.wallMs).toBeGreaterThan(0);
      if (memorySamplingAvailable) {
        expect(result.peakMemKb).toBeGreaterThan(0);
      } else {
        // macOS 受限沙箱可能禁止 ps；SPEC §11 明确这种环境无法提供内存采样。
        expect(result.peakMemKb).toBe(0);
      }
    },
    20_000,
  );

  it(
    'stdin 关闭后程序自行退出不算失败',
    async () => {
      const run = await build('empty-stdin', ECHO_SUM);
      if (!run) {
        return;
      }
      // 没有输入 -> scanf 返回 EOF -> main 返回 1，应当是 RE 而不是挂死
      const result = await sandbox.run(run, Buffer.alloc(0), limits({ timeMs: 5000 }));
      expect(result.status).toBe('RE');
      expect(result.exitCode).toBe(1);
    },
    20_000,
  );
});

describe('sandbox：超限与异常', () => {
  it(
    '死循环判 TLE，并在时限附近被杀掉',
    async () => {
      const run = await build('tle', INFINITE_LOOP);
      if (!run) {
        return;
      }
      const result = await sandbox.run(run, Buffer.alloc(0), limits({ timeMs: 300 }));

      expect(result.status).toBe('TLE');
      expect(result.wallMs).toBeGreaterThanOrEqual(250);
      expect(result.wallMs).toBeLessThan(5000);
    },
    20_000,
  );

  it(
    '内存超限判 MLE 并记录峰值',
    async () => {
      const run = await build('mle', MEMORY_HOG);
      if (!run || !memorySamplingAvailable) {
        // 没有编译器或平台禁止读取进程内存时，无从验证 MLE；正常 CI 仍会完整跑这条。
        return;
      }
      const result = await sandbox.run(
        run,
        Buffer.alloc(0),
        limits({ timeMs: 10_000, memoryMb: 64 }),
      );

      expect(result.status).toBe('MLE');
      expect(result.peakMemKb).toBeGreaterThan(64 * 1024);
    },
    30_000,
  );

  it(
    '输出超限判 OLE，并截断到上限',
    async () => {
      const run = await build('ole', OUTPUT_SPAM);
      if (!run) {
        return;
      }
      const result = await sandbox.run(
        run,
        Buffer.alloc(0),
        limits({ timeMs: 10_000, outputKb: 64 }),
      );

      expect(result.status).toBe('OLE');
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
    },
    30_000,
  );

  it(
    'abort 判 RE',
    async () => {
      const run = await build('re', ABORT_PROGRAM);
      if (!run) {
        return;
      }
      const result = await sandbox.run(run, Buffer.alloc(0), limits({ timeMs: 5000 }));

      expect(result.status).toBe('RE');
      expect(result.exitCode).not.toBe(0);
    },
    20_000,
  );

  it('可执行文件不存在判 INTERNAL，原因写在 stderr', async () => {
    const result = await sandbox.run(
      { cmd: path.join(workDir, 'no-such-binary'), args: [] },
      Buffer.alloc(0),
      limits(),
    );

    expect(result.status).toBe('INTERNAL');
    expect(result.stderr.toString().length).toBeGreaterThan(0);
  });

  it(
    '取消令牌触发后判 TLE（SPEC §8.5 把取消与超时归为同一类）',
    async () => {
      const run = await build('cancel', INFINITE_LOOP);
      if (!run) {
        return;
      }

      const listeners: Array<() => void> = [];
      const token: CancellationTokenLike = {
        isCancellationRequested: false,
        onCancellationRequested(listener: () => void) {
          listeners.push(listener);
          return { dispose: () => undefined };
        },
      };
      const cancelTimer = setTimeout(() => {
        for (const listener of listeners) {
          listener();
        }
      }, 150);

      try {
        const result = await sandbox.run(
          run,
          Buffer.alloc(0),
          limits({ timeMs: 30_000 }),
          token,
        );
        expect(result.status).toBe('TLE');
        expect(result.wallMs).toBeLessThan(10_000);
      } finally {
        clearTimeout(cancelTimer);
      }
    },
    30_000,
  );
});
