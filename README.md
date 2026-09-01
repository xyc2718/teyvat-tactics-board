# 提瓦特世界杯战术板

一个面向电脑浏览器的 3v3 教练战术板。`v0.1.0` 支持自由布置、连续时间轴播放、规则辅助、参数校准和 JSON 战术文件交换。

## 在线使用

- 在线战术板：[https://xyc2718.github.io/teyvat-tactics-board/](https://xyc2718.github.io/teyvat-tactics-board/)
- 源码仓库：[https://github.com/xyc2718/teyvat-tactics-board](https://github.com/xyc2718/teyvat-tactics-board)

## 本地运行

需要 Node.js 20.19+ 和 pnpm。

```powershell
pnpm install
pnpm dev
```

浏览器打开终端显示的本地地址（通常为 `http://localhost:5173`）。

生产构建：

```powershell
pnpm build
pnpm preview
```

构建产物位于 `dist/`。本地构建使用相对资源路径，GitHub Actions 发布时自动使用仓库子路径。

## 快速使用

1. 在“选择”模式下拖动双方球员和足球，点击球员后可在右侧设置职业、面向和球权。
2. 选中球员，再选择“跑动”“Q 技能”“传球”或“射门”，随后点击球场目标点；跑动和 Q 也可直接从已有动作终点继续编排。
3. 点击已绘制路径可拖动控制点；水灵 Q 可通过中间控制点转弯并自动限制最大长度。
4. 点击“添加下一步”，从当前战术末尾继续创建新的讲解节点。
5. 使用底部播放、暂停、回到开头和时间滑块复盘；“高级时间”可编辑动作开始偏移与持续时间。
6. 默认界面只显示关键内容；打开“分析层”查看攻击/Q 范围、传球截断锥和身位分段。
7. “规则设置”中的近似数值、基础对位和场景修正均可修改，并会随战术文件保存。

快捷键：`V` 选择、`M` 跑动、`Q` Q 技能、`P` 传球、`S` 射门、`A` 说明、空格播放/暂停、`Ctrl+Z` 撤销、`Ctrl+Y` 重做。

## 数据与范围

- 自动草稿保存在当前浏览器的 `localStorage`。
- 导出文件包含 `schemaVersion: 1`、完整规则快照、场景、步骤和动作；导入前会校验格式和 2 MB 大小限制。
- MVP 只包含水灵、蛮牛、霜役，不包含后端、账号、云同步、战术分享链接、移动端完整编辑或自动胜负预测。

## 质量检查

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 开源协议

本项目以 [GNU General Public License v3.0](./LICENSE) 发布，SPDX 标识为 `GPL-3.0-only`。

Copyright © 2026 xyc.
