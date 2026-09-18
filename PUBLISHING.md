# 发布到插件市场

这份文档写给「第一次发布 VS Code 扩展」的人。所有需要浏览器与账号的步骤都标了
**[你来]**——发布这件事必须有你的凭据，工具代替不了。

## 发布前先补齐这些

市场页面就是把 `README.md` 渲染出来，再加上 `package.json` 里的描述、图标和分类。
所以这三样是硬要求：

1. **README.md** — 有（仓库根目录），市场页直接用它。
2. **图标** — 有（`media/icon.png`，128×128 RGBA PNG；源图留在 `assets/icon-source.png`，
   想换图标时从源图导出 128×128 覆盖它即可）。
3. **`repository` 字段** — 有（指向 GitHub）。缺了它 `vsce` 会报错。

另外三样已经在仓库里，但每次发版要记得顺手维护：

- **`LICENSE` 文件**：已经有了（MIT，版权归 Pt-ll），`package.json` 里也写了 `"license": "MIT"`。
  打包时会一并放进 VSIX，并在清单里写上 `<License>`——市场页面上那行「License: MIT」
  就是从清单读的，这一步漏了页面会显示成「没有许可证」。
- **`CHANGELOG.md`**：发版时在顶部加一节（版本号 + 日期 + 这一版改了什么）。它会进 VSIX，
  市场页面据此多出一个「Changelog」标签页，README 里也有指向它的链接。
- **截图**：市场页面里放几张截图（Testing 面板、榜单 WebView、diff）会明显提升可信度。
  放到 `media/screenshots/`，在 README 里用相对路径引用即可。

## 路线 A：VS Code Marketplace（官方市场）

### 1. 创建 publisher **[你来]**

1. 用 Microsoft 账号登录 <https://marketplace.visualstudio.com/manage>
   2. 按页面引导创建 publisher：**ID 填 `YuChenZhong`**（与 `package.json` 里的 `publisher`
   一致，本仓库已经写成这个）。扩展 ID 因此是 `YuChenZhong.verdict-judge`。

   > **为什么扩展 ID 不叫 `verdict`**：`verdict` 这个名字在市场上已经被占用（上传时提示
   > 「命名重复」），所以 `package.json` 的 `name` 改成了 `verdict-judge`。扩展**内部**的东西
   > 一律没变：命令还是 `verdict.*`，设置还是 `verdict.*`，工作区目录还是 `.verdict/`。
   > 要换别的后缀，只改 `package.json` 的 `name` 与 `test/integration/index.js` 的
   > `EXTENSION_ID` 两处即可。

   创建页对 ID 的大小写可能有自己的要求（有些年份的页面会强制小写）。真遇到那种提示，
   就把三处一起改成市场接受的形式——`package.json` 的 `publisher`、本文档的示例命令、
   `test/integration/index.js` 的 `EXTENSION_ID`。

   **用户侧不受影响**，这点本仓库实测过：用带大写的清单装进 VS Code 后，
   `code --list-extensions` 显示的是小写形式 `yuchenzhong.verdict`——VS Code 会把扩展 ID
   归一成小写，查找也不区分大小写（集成测试用两种写法都能找到扩展）。所以 publisher 的
   大小写只影响发布这一步，不影响已经装上的人。

   发布前定下来最好：以后再改 ID，装过旧版本的人会看到两个扩展（旧的不会自动消失）。

### 2. 发布：先试不用 PAT 的那条路

**网页上传（推荐，不需要 PAT）**

1. 打开 <https://marketplace.visualstudio.com/manage> **[你来]**
2. **New extension** → 选 **Visual Studio Code**（下拉里如果只有 Azure DevOps /
   Visual Studio，说明账号的租户还没打通，见下面第 3 步）
3. 把 `dist/verdict-judge-0.1.3.vsix` 拖进去，确认

上传走的是网页表单，跟命令行那套 Azure DevOps 令牌无关。**本仓库的发布就卡在
令牌生成上（见文末的 TF400898），所以这条路是首选。**

**命令行（需要 PAT）**：见下面第 3 步与第 4 步。

### 3. 生成访问令牌（PAT） **[你来]**

1. 打开 <https://dev.azure.com> → 右上角用户设置 → **Personal access tokens** → New Token
2. **Organization** 选 `All accessible organizations`；**Scopes** 选 `Marketplace` → `Manage`
3. 生成后立刻复制：它只显示一次

（这一步报「租户里没有该账号」时，先按文末第 1 条建一个 Azure DevOps 组织。）

### 4. 安装发布工具（这一步要联网）

```bash
npm install -g @vscode/vsce
vsce login YuChenZhong        # 粘上一步的 PAT（若报 Publisher not found，见上面的大小写说明）
```

### 5. 打包并发布

两种打包方式任选（两条路的产物都是精简的：我们自己的打包器走白名单，
`.vscodeignore` 则保证 `vsce` 自己打包时不会把源码、测试、样例数据一起塞进去）：

```bash
# 方式一：用本仓库自带的打包器产出 VSIX，再交给 vsce 上传
# （我们的打包器零依赖、离线可用；vsce 只负责上传与市场校验）
pnpm package
vsce publish --packagePath dist/verdict-judge-0.1.3.vsix

# 方式二：完全交给 vsce 打包
vsce publish
```

发布成功后几分钟内会出现在
<https://marketplace.visualstudio.com/items?itemName=YuChenZhong.verdict-judge>。

### 6. 以后每次更新

市场不接受重复版本号，所以每次先升 `package.json` 里的 `version`：

```bash
npm version patch             # 0.1.2 -> 0.1.3（或 minor / major）
git push --follow-tags
pnpm package && vsce publish --packagePath dist/verdict-judge-0.1.3.vsix
```

升完版本顺手在 `CHANGELOG.md` 顶部加一节：它会被打进 VSIX，市场页面据此多出一个
「Changelog」标签页（README 里也有指向它的链接）。

## 路线 B：Open VSX（VSCodium / Gitpod / Theia 用的是它）

如果你的用户里有不用官方 VS Code 的人，值得再发一份：

**这条路也是「官方市场卡住时的应急出口」**：它完全不碰微软账号，用 GitHub 登录即可。
如果路线 A 卡在 Azure DevOps 的鉴权或后台报错上（见文末「真实遇到过的两类报错」），
先把这一份发出去——**同一份 VSIX，两边都收**，不用重新打包，官方市场能用了再补上。

1. 用 GitHub 账号登录 <https://open-vsx.org> **[你来]**
2. 右上角头像 → Settings → Access Tokens → 生成 **[你来]**
3. **先建命名空间**（Open VSX 与官方市场不同：它不会自动给你建 publisher，首次发布前
   必须显式创建一次，名字必须与 `package.json` 的 `publisher` 完全一致）：

```bash
npx ovsx create-namespace YuChenZhong -p <你的 token>
```

4. 发布：

```bash
npx ovsx publish -p <你的 token> dist/verdict-judge-0.1.3.vsix
```

   它会提示命名空间是 "unverified"（没打勾）：不影响发布与安装。那个认证徽章要求命名空间
   与你的 GitHub 用户名一致；想拿到就把命名空间与 `package.json` 的 `publisher` 一起换成
   你的 GitHub 用户名。

## 常见被拒原因

| 现象 | 原因 |
| --- | --- |
| `Missing repository field` | `package.json` 里没有 `repository`（本仓库已补） |
| `Publisher 'xxx' not found` | `package.json` 的 `publisher` 与市场上创建的没对上 |
| 版本冲突 | 同一个版本号发了第二次，先 `npm version patch` |
| 图标不显示 | 不是 128×128 的 PNG，或 `package.json` 里忘了写 `icon` 字段 |
| 打包后体积异常 | 把 `node_modules/` 之类打进去了；本仓库的打包器按白名单来，不会有这个问题 |

## 我们的 VSIX 为什么会被市场打回（TF400898）

2026-09-13 上传 0.1.0 时撞到的（修好之后发的是 0.1.1）。原因**不在 Markdown、也不在 `package.json` 字段**（那些都齐），
而在包本身的格式：`pnpm package` 用的是本仓库自带的打包器（SPEC §17.3），
`code --install-extension` 对它的校验比市场后端松得多。实测出来的两处硬伤：

1. `[Content_Types].xml` 里有一条 `<Default Extension="" ContentType="application/octet-stream" />`。
   OPC 包的内容类型是一张按后缀建的表，**空后缀是非法写法**，后端建表时直接崩——报出来的
   就是那个不告诉你原因的 TF400898。当时那条是为了覆盖没有后缀的 `LICENSE`。
2. `extension.vsixmanifest` 只声明了 `Microsoft.VisualStudio.Code.Manifest` 一条资产，
   缺 `Content.Details`（README）、`Content.Changelog`、`Content.License` 与 `Icons.Default`，
   也缺 `<Icon>` 以及仓库相关的 Links / Branding 属性。

修法已经落在 `src/tools/vsix.ts`：

- `[Content_Types].xml` 按**包内实际文件**生成：后缀带点（与 vsce 一致），没有后缀的 part
  用 `<Override>` 单独声明，不再出现空后缀；
- 清单补齐 vsce 会写的资产与属性（详情 / 更新日志 / 许可证 / 图标 + Links / Branding / Pricing）；
- 包内的 README / CHANGELOG / LICENSE 改名成市场约定的 `readme.md` / `changelog.md` / `LICENSE.txt`；
- `test/vsix.test.ts` 盯着这三件事，其中一条用例**直接拿真实仓库打一次包**再断言。

另一类坑与上面的无关但同样坑人：vsce **不认** `.vscodeignore` 里的排除写法（实测写
`dist/*.map` 也没用），所以走 vsce 打包前得先清 `dist/`，否则 sourcemap 与上一次的 VSIX
会被卷进包里：

```bash
node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"
npx @vscode/vsce package        # 输出落在仓库根目录，不会被自己卷进去
```

## 发布过程中真实遇到过的两类报错

这两条是首次发布时实际撞上的，记下来省得再摸索一遍。

**「所选的用户帐户在租户"Microsoft Services"中不存在…需要先将该帐户添加为该租户的外部用户」**

生成 PAT 时出现。意思是这个微软账号不属于任何 Azure DevOps 组织，而发布权限挂在
Microsoft Services 租户下。两个常见原因：

1. 这个账号从没建过 Azure DevOps 组织 → 用**同一个账号**访问 <https://aex.dev.azure.com>
   （这是「我的组织列表」页）：列表为空就点 **Create new organization**；已经有组织就直接进去。
   另一个入口是 <https://dev.azure.com>，它会转到组织选择页，左上角组织下拉框的最底部
   也有 **New organization**。创建时 Name 要全局唯一（例如 `yuchenzhong-verdict`），
   Region 选离你近的即可。这一步会顺带给账号建一个后台租户——正是上面那条报错缺的东西。
   建好之后：进组织 → 右上角用户设置 → Personal access tokens → New Token。
2. 登录 Azure DevOps 和登录市场的不是同一个账号 → 开隐私窗口重新登录，保证两边一致。

另一个更省事的选择是**根本不用 PAT**：在市场的 manage 页面用 "New extension → Visual Studio Code"
直接上传 VSIX。

**TF400898: An Internal Error Occurred. Activity Id: …**

Azure DevOps 服务端的内部错误，与你的操作、与扩展本身都无关（Activity Id 是给微软支持追踪用的）。
多数是瞬时的：等几分钟重试、换隐私窗口/浏览器重登、顺手看一眼 <https://status.dev.azure.com>。

这个错在本仓库的发布过程中**反复出现过**（生成 PAT 那一步，例如
`Activity Id: 6309f885-d319-4b90-9fda-b112881b96d0`）。所以别在这条路上耗：

1. 先走**路线 A 的网页上传**（manage 页面直接传 VSIX）——不用 PAT，也就碰不到这个错；
2. 再不济走**路线 B**（Open VSX，完全不需要微软账号）；
3. 非要修命令行发布，就先确认账号已有 Azure DevOps 组织（见上文第 1 条），再重试生成 PAT。

## 这个仓库当前的状态

- `pnpm package` 产出的 VSIX 已在本机用 `code --install-extension` 装过一次，确认官方安装器
  接受它的清单（装完已卸载）。
- **当前版本 0.1.3**（测试数据总库 / 一个工作区多场比赛 / 删除题目 / 成绩单测试点详情）。
  版本线：0.1.0 侧边栏评测面板 → 0.1.1 修 VSIX 格式 → 0.1.2 修三处使用反馈 → 0.1.3。
  待发版本的包由 `pnpm package` 产出（`dist/verdict-judge-<版本>.vsix`，自带打包器，
  已按市场格式对齐，见上一节），首选上传这个。历史上还留过一个 `-vsce` 备用包，
  格式修好之后不再需要它。
  包里带 `CHANGELOG.md`，市场页因此会有 Changelog 标签页。
- **Open VSX：已发布 0.0.1**（命名空间 `YuChenZhong`，2026-09-13），后续版本待发。未认证
  （要求命名空间与 GitHub 用户名一致），不影响安装。
  页面：<https://open-vsx.org/extension/YuChenZhong/verdict-judge>。
  注意：改名之前的 0.0.1 发在 `YuChenZhong.verdict`，那个页面会停在 0.0.1；新版本一律发到
  `verdict-judge`。老页面上的用户不会自动收到更新，想让他们迁过来只能在新页面里说明。
- **官方市场：尚未发布**。publisher 已创建，但生成 PAT 这一步反复撞上 TF400898；
  `marketplace.visualstudio.com/items?itemName=YuChenZhong.verdict-judge` 现在还是 404。
  下一步走**网页上传**（见路线 A 第 2 步）。
- 发布前确认三平台 CI 全绿（推 `main` 会自动跑）。
