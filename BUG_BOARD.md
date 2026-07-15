# Bug Board

> AI 负责原地维护。代码改完进入“待你验证”；用户明确确认通过后，立即移入“已完成”。

## 待你验证

- [ ] Docker 构建因 wacli module path 冲突失败 `[P1]`
  - 现象：wacli v0.12.0 声明 `github.com/openclaw/wacli`，镜像仍从旧的 steipete 路径安装。
  - 验证：重新构建镜像，Go 工具阶段成功安装 wacli 并继续执行后续层。

## 待处理

- 暂无。

## 已完成

- 暂无。
