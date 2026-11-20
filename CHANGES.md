# 修改记录 — vnite

## 2026-11-20 — 融合 v4.15.0

### 背景与目标

将固定上游提交 `3a19f06b7836f45e552d08e8a20b1428e5ca25b0` 融合到基线 `e4db4473`，接入评分、排序、范围选择、重复添加提示及独立进程监控。保留 WebDAV、存档同步空间、路径迁移、添加时附带启动路径、紧凑标题可读性以及现有更新源。

### 影响与兼容性

- 原生模块改为 Rust workspace，同时生成 N-API 模块和独立的 `vnite-process-monitor.exe`；打包资源新增 `monitor/`。增强监控默认关闭，本轮只运行普通模式，没有批准 UAC。
- 游戏路径更新由主进程数据库文档订阅刷新监控；渲染端移除已废弃的 `native-monitor:update-local-game` 通知。
- Steam 跨区抓取由现有地区回退实现承接；AVIF 使用 WASM 解码并保留 icodec 回退，8/10/12 位样例均验证通过。
- 库 WebDAV 同步与游戏存档同步空间继续维持各自原有语义；没有修改真实存档、开发库或真实远端。
- 本地交付位于 `integration/upstream-v4.15.0`，main 保留在 `e4db4473`，旧标签不变。回退可切换回 main 后重建；未推送、未创建 PR、未发布。

### 文件与实现

| 操作      | 路径                                                                                                    | 说明                                                           |
| --------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 修改      | `package.json`、`pnpm-lock.yaml`                                                                        | 更新版本及依赖，保留 webdav，新增 AVIF WASM 与 ZIP 处理依赖    |
| 新增/迁移 | `native/crates/`、`native/Cargo.toml`                                                                   | 分离 N-API、进程监控和 Win32 公共代码；按 Rust 格式规范整理    |
| 修改      | `electron-builder.yml`、`electron.vite.config.ts`                                                       | 打包监控程序并保留 fork 更新配置                               |
| 修改      | `src/main/features/monitor/`、`src/main/core/database/BaseDBManager.ts`                                 | 接入新监控、文档变更订阅与生命周期处理                         |
| 修改      | `src/main/features/scraper/`、`src/main/utils/image.ts`                                                 | 接入评分与请求处理，整合地区回退和 AVIF 解码                   |
| 修改      | `src/main/features/game/ipc.ts`、`src/types/ipc.ts`                                                     | 合并新增接口与原有同步空间契约                                 |
| 修改      | `src/renderer/src/pages/GameAdder/`、`src/renderer/src/components/Game/Config/Properties/Path/main.tsx` | 适配新的添加函数和监控更新方式，保留本地路径功能               |
| 修改      | `src/renderer/src/components/`、`src/renderer/locales/`、`src/types/models/`                            | 接入排序、范围选择、重复提示和评分，保留同步提示与紧凑标题渐变 |
| 修改      | `.gitignore`                                                                                            | 追加 CLAUDE.md、GEMINI.md 本地配置忽略规则                     |
| 新增      | `CHANGES.md`                                                                                            | 记录交付范围、验证和限制                                       |

### 验证

- `corepack pnpm@10.34.5 exec tsx --tsconfig .verify-tmp/tsconfig.json .verify-tmp/path-relocation-live-test.ts`：路径迁移契约通过。
- 同入口运行 `sync-space-live-test.ts` 与 `webdav-live-test.ts`：分别 63 项、131 项通过，覆盖存档保护、冲突、删除授权、恢复及 GC。
- `node .verify-tmp/upstream-merge-live-test.mjs`：Steam 地区回退、真实 8/10/12 位 AVIF 与监控路径更新，34 项通过。
- `node .verify-tmp/upstream-monitor-live-test.mjs`：命名管道握手、进程启动/退出、错误令牌和异常帧拒绝，12 项通过。
- `node .verify-tmp/upstream-monitor-lifecycle-test.mjs`：备份中重新启动、删除保护、禁用备份、短会话过滤、监听释放，12 项通过。
- native 目录 `cargo fmt --all --check`、`cargo check --workspace`、`cargo test --workspace -- --skip test_send_notification`：通过，6 项 Rust 单测通过；主动过滤 1 项桌面通知测试，未将其计为通过。
- `corepack pnpm@10.34.5 run build`：通过，包括更新原生产物、主进程/渲染端类型检查和生产构建。
- `electron-builder --win --dir --publish never`：Windows x64 目录包通过；复用已有工具归档提取 Windows 所需文件后重试成功，未提权。
- 154 个受影响 TS/TSX 文件 ESLint 最终退出码为 0；Rust 最终格式检查、`git diff --check HEAD` 通过，无未解决冲突。
- 打包实例真实交互通过：Shift 连选三项、评分排序持久化、重复提示后继续添加并保留启动路径、AVIF 通过实际图片 IPC 解码、明亮背景标题与评分显示、WebDAV 设置入口。
- 打包实例监控自建进程，退出后自动备份并上传本地 HTTP WebDAV；读取远端新 ZIP 校验 SHA-256，并确认解压后的 `slot.dat` 与原始测试字节一致。“复制到本地”后同步空间原件仍在。

本轮日志、截图、隔离启动脚本和目录包位于 `E:/DevData/vnite-upstream-v415/`。详细逐提交保留矩阵及验收记录保存在本地 Trellis 任务 `11-20-merge-upstream-v4-15`，不纳入源码提交。

### 已知限制与后续

- 未运行 UAC 增强模式、真实网盘、在线刮削供应商全量抓取、GitHub 发布和自动更新升级流程。Steam 地区回退使用受控响应验证，不能等同于所有外部站点实网可用。
- 本轮交付为 Windows 目录包，未生成安装包、签名或发布资产。
- 发现的便携目录首次创建时权限判断问题未在本任务扩展修复；隔离验证预建了测试数据库目录。它属于原有启动路径问题。
- 曾错误派发一次继承默认模型的检查代理，已取消且无审查产出；其后审查与验证均由主代理完成。这是已披露的流程偏差，不能计为独立审查或宣称全程无违规调度。
