import * as fs from 'node:fs';
import * as path from 'node:path';
import { createZip, type ZipEntry } from '../core/zip';

/**
 * 把扩展打包成 VSIX。
 *
 * VSIX 本质就是一个 ZIP：`[Content_Types].xml` + `extension.vsixmanifest` + `extension/**`。
 * 这里用自己写的 ZIP 打包器（core/zip.ts），于是打包不需要任何第三方工具——
 * `vsce` 要联网安装，而这个项目的前提是「完全离线、零依赖」。
 *
 * 放在 src/tools/ 而不是 src/core/：它是构建工具，不会被打进扩展本体
 * （esbuild 只从 src/extension.ts 出发打包，不会带上它）。
 */

/** 打进 VSIX 的东西。够跑就行：源码、测试、样例数据都不该进去。 */
const INCLUDED = [
  'package.json',
  'dist',
  'media',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE.txt',
] as const;

/**
 * 包内改名。
 *
 * 市场的后端按这几个**小写约定名**去找 README / CHANGELOG / LICENSE（官方 vsce 也是这么
 * 改名的），照它来能少一类「详情页空白 / 许可证缺失」的问题。仓库里的大写文件名不变，
 * 只改包内的那一份。
 */
const PACKAGE_RENAMES: Record<string, string> = {
  'README.md': 'readme.md',
  'CHANGELOG.md': 'changelog.md',
  LICENSE: 'LICENSE.txt',
  'LICENSE.md': 'LICENSE.txt',
};

interface ManifestJson {
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  publisher?: string;
  engines?: { vscode?: string };
  categories?: string[];
  keywords?: string[];
  license?: string;
  icon?: string;
  main?: string;
  repository?: { url?: string };
  bugs?: { url?: string };
  galleryBanner?: { color?: string; theme?: string };
}

/** 清单里那几个「内容资产」的实际路径（都会带 extension/ 前缀）。 */
export interface ManifestAssets {
  license?: string;
  icon?: string;
  readme?: string;
  changelog?: string;
}

export interface VsixOptions {
  /** 扩展根目录（含 package.json）。 */
  root: string;
  /** 输出文件；缺省 dist/<name>-<version>.vsix。 */
  outFile?: string;
}

export interface VsixResult {
  outFile: string;
  entries: number;
  bytes: number;
  name: string;
  version: string;
}

export async function packageVsix(options: VsixOptions): Promise<VsixResult> {
  const root = path.resolve(options.root);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as ManifestJson;
  // 市场页面上那行「License: MIT」来自清单里的 <License> 元素，vsce 会写，我们也得写——
  // 不然用我们的打包器发上去，页面会显示成「没有许可证」。它的路径在下面按实际进包的文件算。
  const collected: ZipEntry[] = [];
  for (const item of INCLUDED) {
    collected.push(...(await collect(root, item, 'extension')));
  }
  const files = collected
    .map((entry) => ({ ...entry, name: renameInPackage(entry.name) }))
    .map((entry) =>
      entry.name === 'extension/package.json'
        ? { ...entry, data: Buffer.from(`${JSON.stringify(prunePackagedManifest(manifest), null, 2)}\n`, 'utf8') }
        : entry,
    );
  const assets = assetsOf(manifest, files.map((entry) => entry.name));

  const entries: ZipEntry[] = [
    {
      name: 'extension.vsixmanifest',
      data: Buffer.from(manifestXml(manifest, assets), 'utf8'),
    },
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        contentTypesXml(['extension.vsixmanifest', ...files.map((entry) => entry.name)]),
        'utf8',
      ),
    },
    ...files,
  ];

  const zip = createZip(entries);
  const outFile =
    options.outFile ?? path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  await fs.promises.writeFile(outFile, zip);

  return {
    outFile,
    entries: entries.length,
    bytes: zip.length,
    name: manifest.name,
    version: manifest.version,
  };
}

/** 递归收集；路径在包内一律用 '/'，且统一带上 extension/ 前缀（VSIX 的约定）。 */
async function collect(root: string, relative: string, prefix: string): Promise<ZipEntry[]> {
  const target = path.join(root, ...relative.split('/'));
  const info = await statOrNull(target);
  if (info === null) {
    return [];
  }

  if (info.isFile()) {
    return [{ name: `${prefix}/${relative}`, data: await fs.promises.readFile(target) }];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const entries: ZipEntry[] = [];
  for (const item of await fs.promises.readdir(target, { withFileTypes: true })) {
    if (item.name.startsWith('.')) {
      // .DS_Store 之类不进包；点文件在扩展里也没有用处。
      continue;
    }
    if (item.name.endsWith('.map')) {
      // 开发用的 sourcemap 不进生产包：它体积最大，而且开发构建留下的那份很可能
      // 与这次打进去的代码对不上——错误的 sourcemap 比没有 sourcemap 更糟。
      continue;
    }
    if (item.name.endsWith('.vsix')) {
      // 输出就写在 dist/ 下：不跳过的话会把上一次的包打进这一次的包里（套娃）。
      continue;
    }
    entries.push(...(await collect(root, `${relative}/${item.name}`, prefix)));
  }
  return entries;
}

/**
 * 包内的 package.json 要去掉开发期字段。
 *
 * 官方 vsce 也是这么做的：`devDependencies` 与 `scripts` 对使用者毫无意义，
 * 其中 `vscode:prepublish` 更是只在打包时该跑 —— 留一份在用户机器上，等于把一个
 * 会在别处被误执行的脚本一起发出去。市场后端不校验这些字段，但包该是干净的。
 */
function prunePackagedManifest(manifest: ManifestJson): Record<string, unknown> {
  const pruned: Record<string, unknown> = { ...manifest };
  delete pruned.devDependencies;
  delete pruned.scripts;
  return pruned;
}

/**
 * 生成 `extension.vsixmanifest`。
 *
 * 结构照抄官方 vsce 的产物：市场后端读的就是这一份，少一个 `<Icon>`、少一条
 * `Content.Details` 资产，轻则页面空白，重则直接给一个 TF400898（内部错误）而看不出原因。
 * 所以这里不「够用就行」，而是把 vsce 会写的字段都写上。
 */
export function manifestXml(manifest: ManifestJson, assets: ManifestAssets = {}): string {
  const categories = (manifest.categories ?? []).join(',');
  const tags = (manifest.keywords ?? []).join(',');
  const repository = normalizeRepository(manifest.repository?.url);
  const properties: string[] = [
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(manifest.engines?.vscode ?? '*')}" />`,
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />',
    '      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />',
    `      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="${manifest.main === undefined ? 'false' : 'true'}" />`,
  ];
  if (repository !== null) {
    properties.push(
      `      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${escapeXml(repository)}" />`,
      `      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="${escapeXml(repository)}" />`,
      `      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${escapeXml(repository)}" />`,
      `      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${escapeXml(`${repository}#readme`)}" />`,
    );
  }
  const support = manifest.bugs?.url;
  if (support !== undefined && support.length > 0) {
    properties.push(
      `      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${escapeXml(support)}" />`,
    );
  }
  const banner = manifest.galleryBanner;
  if (banner?.color !== undefined) {
    properties.push(
      `      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${escapeXml(banner.color)}" />`,
    );
  }
  if (banner?.theme !== undefined) {
    properties.push(
      `      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${escapeXml(banner.theme)}" />`,
    );
  }
  properties.push(
    '      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />',
    '      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />',
  );

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(manifest.publisher ?? 'unknown')}" />`,
    `    <DisplayName>${escapeXml(manifest.displayName ?? manifest.name)}</DisplayName>`,
    `    <Description xml:space="preserve">${escapeXml(manifest.description ?? '')}</Description>`,
    `    <Tags>${escapeXml(tags)}</Tags>`,
    `    <Categories>${escapeXml(categories)}</Categories>`,
    '    <GalleryFlags>Public</GalleryFlags>',
    '    <Properties>',
    ...properties,
    '    </Properties>',
    ...(assets.license === undefined ? [] : [`    <License>${escapeXml(assets.license)}</License>`]),
    ...(assets.icon === undefined ? [] : [`    <Icon>${escapeXml(assets.icon)}</Icon>`]),
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />',
    '  </Installation>',
    '  <Dependencies />',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    ...(assets.readme === undefined
      ? []
      : [
          `    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="${escapeXml(assets.readme)}" Addressable="true" />`,
        ]),
    ...(assets.changelog === undefined
      ? []
      : [
          `    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="${escapeXml(assets.changelog)}" Addressable="true" />`,
        ]),
    ...(assets.license === undefined
      ? []
      : [
          `    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="${escapeXml(assets.license)}" Addressable="true" />`,
        ]),
    ...(assets.icon === undefined
      ? []
      : [
          `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="${escapeXml(assets.icon)}" Addressable="true" />`,
        ]),
    '  </Assets>',
    '</PackageManifest>',
    '',
  ].join('\n');
}

/** 已知后缀的内容类型；写法与 vsce 一致（**带点的后缀名**，市场后端照着这个解析）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.vsix': 'application/octet-stream',
  '.vsixmanifest': 'text/xml',
};

/**
 * 生成 `[Content_Types].xml`。
 *
 * 这是 OPC 包的目录：**每一个 part 都必须有内容类型**，否则后端的解析器会在建映射时
 * 直接崩掉——表现出来就是我们撞到的 TF400898，什么原因都不告诉你。
 * 所以这里按包内实际文件算，而不是写死一张表（写死的那张曾经包含一条
 * `Extension=""`，那本身就是一份非法清单）。
 */
export function contentTypesXml(names: string[]): string {
  const extensions = new Set<string>();
  const overrides: { part: string; type: string }[] = [];
  for (const name of names) {
    const extension = path.posix.extname(name).toLowerCase();
    if (extension.length === 0) {
      // 没有后缀的 part 只能用 Override 单独声明。
      overrides.push({ part: `/${name}`, type: 'application/octet-stream' });
      continue;
    }
    extensions.add(extension);
  }
  const defaults = [...extensions]
    .sort()
    .map(
      (extension) =>
        `  <Default Extension="${extension}" ContentType="${CONTENT_TYPES[extension] ?? 'application/octet-stream'}" />`,
    );
  const parts = overrides
    .sort((left, right) => left.part.localeCompare(right.part))
    .map((item) => `  <Override PartName="${item.part}" ContentType="${item.type}" />`);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    ...defaults,
    ...parts,
    '</Types>',
    '',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 包内改名：只动我们约定的那几个顶层文件，其余原样。 */
function renameInPackage(name: string): string {
  if (!name.startsWith('extension/')) {
    return name;
  }
  const renamed = PACKAGE_RENAMES[name.slice('extension/'.length)];
  return renamed === undefined ? name : `extension/${renamed}`;
}

/**
 * 清单里那几条内容资产指向哪些文件。
 *
 * 按**实际打进去的文件**算：README / CHANGELOG / 许可证缺哪个就不写哪条资产，
 * 免得清单指向一个包里不存在的文件（那也是后端报错的一个来源）。
 */
function assetsOf(manifest: ManifestJson, names: string[]): ManifestAssets {
  const present = new Set(names);
  const icon = manifest.icon === undefined ? null : `extension/${manifest.icon}`;
  return {
    ...(present.has('extension/LICENSE.txt') ? { license: 'extension/LICENSE.txt' } : {}),
    ...(icon !== null && present.has(icon) ? { icon } : {}),
    ...(present.has('extension/readme.md') ? { readme: 'extension/readme.md' } : {}),
    ...(present.has('extension/changelog.md') ? { changelog: 'extension/changelog.md' } : {}),
  };
}

/** 仓库地址归一成 `https://github.com/<owner>/<repo>`：市场的那几条链接都要干净的写法。 */
function normalizeRepository(url: string | undefined): string | null {
  if (url === undefined || url.trim().length === 0) {
    return null;
  }
  return url.trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}
