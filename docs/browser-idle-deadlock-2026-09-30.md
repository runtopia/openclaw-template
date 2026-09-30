# 浏览器空闲回收导致全局暂停：线上排查与修复

排查日期：2026-09-30。所有事件时间使用 Asia/Shanghai（UTC+8）。

## 结论与线上证据

受影响的线上 Workspace 使用 `ghcr.io/runtopia/openclaw-template:4.3.5-standard`。通过用户已登录的管理后台确认实例归属，再读取 Railway 部署日志、Console 中的脱敏控制文件和已安装 Wrapper 源码；排查时未修改线上文件、控制权、配置或部署。

后台的 Workspace、Railway 项目、服务和部署标识已逐项核对。实例标识和完整定位证据保留在本地私有排查记录中。

- 2026-09-29 18:44:22.361：`browseruse.preview` 成功，耗时 166ms。
- 19:14:21.423：`browseruse.control` 失败，3020ms，`Preview is unavailable`。
- 19:14:48.548：控制文件记录了一条新的 `viewer / browser.close` 执行租约。
- 19:14:56.556：`browseruse.control` 失败，8140ms，`The operation was aborted due to timeout`。
- 19:14:56.561：随后的控制调用立即失败，`No admitted task operation owns this browser tab`。
- 2026-09-30 排查时，控制文件仍为 `mode=paused`、`epoch=13`，只有上述 `browser.close` 租约，`uncertain=true`。

该租约属于生命周期关闭流程的 `runId=viewer`，不是用户人工接管，也不是遗留的普通 exec。安装的 `/app/src/browser/handoff.js` 确认 `tick()` 在 `serial()` 中等待 `suspendIdleBrowser()`；后者等待插件 `close-task`。日志中的约 30 分钟间隔、8 秒超时、迟到回调拒绝和控制文件残留与本地复现一致。

## 根因

调用链：

1. Wrapper `tick → serial → suspendIdleBrowser` 持有串行队列。
2. 回收调用 Gateway 插件的 `browseruse.control / close-task`。
3. 插件保存任务截图，创建 `browser.close` 租约，调用 Wrapper `/browser/internal/close`。
4. Wrapper `focusTask(..., 'close')` 也通过 `serial` 排队，等待第 1 步退出；第 1 步正在等待第 3 步完成。
5. 插件的 8 秒 HTTP 超时将关闭结果判为未知，保留租约并全局暂停；回收退出后，排队中的关闭验证因 paused/uncertain 被拒绝。

结果是正常回收产生了永久阻塞，而不是正常的空闲资源释放。`control.begin()` 会拦截 paused 下的所有受管工具（browser、exec、process、gateway、nodes），所以诊断工具也无法执行。控制状态持久化到文件，重新加载仍保留租约；`recover` 必须在租约已排空时才能成功。延长等待或普通重启不解决这条残留。

## 本地修复

分支：`codex/browser-idle-deadlock`。

- 查询回收候选和停止共享浏览器仍通过 Wrapper 串行队列。
- 等待插件 `close-task` 时退出该队列，让经过租约验证的 `/internal/close` 回调可以执行。
- 用共享的维护 Promise 合并重复 tick，防止等待回调期间重复回收同一任务。
- 关闭任务页后重新核对停止状态、连接、观看活动和控制者，再查询最新候选并通过 `idle-begin` 校验任务版本和执行租约。
- 明确处理 `close-task` 失败。没有加入按时间丢弃未知租约或自动恢复 AI 权限的逻辑。

插件源码、包版本和内容寻址归档没有改变；Web 不需要修改。

## 验证

新增 `test/browser-idle-runtime.test.js` 解包当前锁定的 Browser Use 归档，把真实插件的关闭与控制状态机连接到 Wrapper。只缩短测试中的 HTTP 等待期限，保留执行租约、回调排队和结果未知处理。

修复前，正常回收测试进入 paused，原生关闭尚未开始；修复后验证：

- 多页任务正确关闭，保存最终截图，执行租约归零，AI 保持可用；空浏览器在自身空闲期后才停止。
- 同时触发两个 tick 只回收一次。
- 原生关闭真正超时时仍 paused、保留租约、不停止浏览器，也不能直接 recover。
- 回收截图期间重新查看会阻止整浏览器停止；人工接管会阻止原生关闭和共享浏览器停止。

相关 17 项测试、`node --check src/browser/handoff.js`、`git diff --check` 均通过。Runtime 全量 `node --test` 为 300/300，无跳过；原始输出在本地 `/tmp/oneclaw-browser-idle-tests-20260930.log`。

## 发布范围

本修复按 `develop → main → v4.3.6` 发布，镜像构建沿用现有 tag CI。代码发布不包含清理生产租约、修改生产空闲阈值或强制关闭正在使用的浏览器。

恢复这条已确认的旧 viewer 关闭租约，需要按实例定点处理：先阻止旧回收再次触发并确认没有其他执行或人工输入，备份控制状态，再仅处理已核实的残留并显式恢复。不能直接删除整个控制目录、清空所有 active 或恢复其他未知操作。发布修复能防止重现，但不会自动消除现有控制文件中的这条 uncertain 租约。
