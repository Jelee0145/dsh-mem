# dsh-mem — 跨会话记忆能力接缝

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)的**树外 bundle 插件**,实现完整的**能力接缝**(capability seam)三件套:Service Definition + Service Provider + Consumer(模型工具)。它给 Agent 提供跨会话的长期记忆:`memory_save` / `memory_recall` / `memory_forget` / `memory_list` 四个工具,把事实、偏好、决策存入 `$DSH_HOME/memory/memory.json`,任何会话都能检索。

## 接缝三件套

| 角色 | 模块 | 挂载行 | 说明 |
|---|---|---|---|
| Service Definition | `src/memory.ts`(`dsh-mem/memory`) | —(不是插件行) | 抽象类 `MemoryService`,声明 `ctx.memory` 契约与类型;直接加载会报错 |
| Service Provider | `src/provider.ts`(`dsh-mem/provider`) | `memory` | `MemoryFile extends MemoryService`,JSON 文件持久化,原子写入 |
| Consumer | `src/tool.ts`(`dsh-mem/tool`) | `tool-memory` | 函数插件,在 `ctx.tools` 上注册四个工具;每次调用经 `ctx.get('memory')` 解析服务 |

参考 dsh 仓库里的同类结构:`ctx.jobs`(Definition 在 `packages/jobs/jobs`,Provider 在 `jobs-local`,Consumer 在 `tool-jobs`)。

## 目录结构

```
dsh-memory/
├── package.json          # dsh.bundle.patch → ./cordis.patch.yml
├── cordis.patch.yml      # bundle 层:插入 memory + tool-memory 两行
├── tsconfig.json         # 独立构建配置(npm 依赖提供类型)
├── tsconfig.check.json   # 开发用:扩展仓库 tsconfig.base,用仓库源码做类型检查
├── README.md
└── src/
    ├── memory.ts         # Service Definition(默认导出服务类)
    ├── provider.ts       # Provider(默认导出服务类 + static Config)
    └── tool.ts           # Consumer(仅命名导出,name/inject/Config/apply)
```

## 构建

```sh
npm install      # 拉取依赖(编译与运行时类型都来自 npm)
npm run build    # tsc 产出 lib/ (prepare 脚本同款,git 安装时自动执行)
```

在 dsh 仓库 checkout 旁开发时,本目录的 `node_modules/@deepseek-ai/*` 已用 junction 链接到仓库包(`cordis`、`schemastery`、`dsh-tools`、`dsh-brand`、`dsh-atomic-write`、`cordis-plugin-include`,`node_modules/js-yaml` 同理),因此可以不 `npm install` 直接做本地类型检查:

```sh
pnpm exec tsc -p dsh-memory/tsconfig.check.json   # 类型检查(不产出)
pnpm exec tsc -p dsh-memory/tsconfig.json         # 产出 lib/
```

测试脚本(需先构建 lib):

```sh
node dsh-memory/tests/patch-smoke.mjs     # patch 组合烟雾(空 base + web 风格 base)
node dsh-memory/tests/provider-smoke.mjs  # Provider 全流程烟雾(持久化/搜索/边界/损坏文件)
```

## 安装进 profile

从 **npm registry** 安装(包名 `dsh-mem`):

```sh
dsh plugin --profile <name> add dsh-mem
```

> `dsh plugin add` 是 dsh 安装插件的标准方式:它从 npm 解析包(经 pnpm)装进 profile 并注册 bundle 层。**不要**用 `npm install dsh-mem`——那只会把它装成普通依赖,不会激活任何 profile 层。

从 git 安装(会跑包自带的 `prepare` 构建;首次安装需在 profile 的 `pnpm-workspace.yaml` 里授权构建):

```sh
dsh plugin --profile demo add github:Jelee0145/dsh-mem
```

或本地目录安装:

```sh
dsh plugin --profile demo add ./dsh-memory
```

首次使用会初始化 `demo` profile,`dsh` 把这个包追加进 `dsh.profile.bundles`(位于 `@deepseek-ai/dsh-base` 之后),pnpm 链接本目录并安装它声明的 `@deepseek-ai/dsh-*` 依赖。验证层与启动:

```sh
dsh --profile demo --dump-config   # 应看到 "# == dsh-mem" 层与 memory/tool-memory 行
dsh --profile demo                 # 启动;新会话即可使用 memory_* 工具
```

卸载:`dsh plugin --profile demo remove dsh-mem`。从 git 或 npm 安装、tarball 分发等打包细节见 dsh 官方教程[打包与安装插件](../../docs/user/develop/basic/publish.zh.md)。

## 记忆条目与存储

一条记忆是 5~6 个字段的不可变记录:

| 字段 | 来源 | 说明 |
|---|---|---|
| `id` | provider 自动 | `m-<n>`,重启续号不重复 |
| `content` | 模型提供 | 记忆正文(自由文本,模型按描述写成完整句子/短段落) |
| `tags` | 模型提供 | 关键词,检索用;空串丢弃 |
| `project` | 模型提供 | 所属项目/工作区(如仓库名);缺失 = 全局记忆,适用于所有项目 |
| `createdAt` / `updatedAt` | provider 自动打戳 | epoch 毫秒;**时间由系统记录,模型不用传**;工具输出里附带人类可读的 `createdAtText`(ISO 8601) |

存到 `$DSH_HOME/memory/memory.json`(默认 `~/.dsh/memory/`),文件形如:

```json
{
  "version": 1,
  "nextId": 3,
  "entries": [
    {
      "id": "m-1",
      "content": "Project X uses pnpm workspaces and rejects yarn.",
      "tags": ["project", "tooling"],
      "project": "project-x",
      "createdAt": 1753000000000,
      "updatedAt": 1753000000000
    }
  ]
}
```

## 设计说明

- **为什么 Provider 自管 JSON 文件,而不是用 `ctx.storage` 接缝**:dsh 的存储行(`storage` / `storage-json` / `storage-domain`)由 `dsh-web-app` bundle 挂载,`dsh-base` 不含它们;一个树外 bundle 若再插入同名行,在同时挂载 web-app 的 profile 里会产生重复行。自管一个 JSON 文档让本插件在任何 profile(web / headless / 自定义)上零依赖可用。想换成 `ctx.storage.domain` 后端时,只需另写一个继承 `MemoryService` 的 Provider,工具与契约完全不用动——这正是接缝的意义。
- **耐久性**:每次变更先写内存再 `writeFileAtomic`(临时文件 + 原子 rename,`0o600`/`0o700`),落盘成功才对外可见;所有操作(含读)走同一进程内队列,读永远不会看到未落盘的写。并发多个 dsh 进程共享同一个 root 不受支持。
- **文档格式**:`{ version, nextId, entries }`,`nextId` 持久化保证跨重启 id 不重复;版本不符或文件损坏在加载时**大声失败**,绝不静默清空。
- **模型工具契约**:搜索是内容的大小写不敏感子串匹配 + 精确 tag 匹配,空查询返回最新;`recall`/`list` 可传 `project` 精确过滤(大小写不敏感,全局记忆不含 project 因此永远不匹配项目过滤);`recall`/`list` 的 limit 由部署配置 `maxRecallLimit` 钳制;内容超长、limit 非法、id 格式非法都在工具边界拒绝。保存时机与内容取舍由工具描述文案引导模型判断:项目相关事实必须带 `project`,全局事实(如用户偏好)不带;`createdAt` 由 provider 自动打戳,模型无法伪造。
- **依赖声明**:`@deepseek-ai/cordis@^4.0.1`、`@deepseek-ai/dsh-*@^0.1.0-rc.6` 均已发布到 npm,`dsh plugin add` 会为 profile 安装它们。

## 扩展点

- **换 Provider**:新建 `class MyMemory extends MemoryService`,在 `cordis.patch.yml` 里把 `memory` 行的 `name` 指向它。
- **加人类命令**:在工具插件里注入 `ctx.commands`(base 已提供),注册 `/memory` 之类的斜杠命令。
- **会话内注入**:在 `agent/pre-step` 或 `tools/post-execute` 监听器里调用 `agent.inject()`,把与当前任务相关的记忆主动塞进下一次请求。
- **换存储位置**:在 profile 的 `cordis.patch.yml` 里整行覆盖 `memory` 行的 `config.root`(注意 patch 是整行替换,要重述保留的键)。

## 已知限制

- 单进程写模型:两个 dsh 进程共享一个 `root` 时没有跨进程锁。
- 无编辑 API:`updatedAt` 目前恒等于 `createdAt`;覆盖旧事实请 `forget` 后重新 `save`。
- 无结构化 schema:内容就是文本;需要字段化记忆(如"用户: 姓名=张三")时,约定模型用固定文本格式存入。
