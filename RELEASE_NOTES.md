## v4.12.3

> Personal fork of [ximu3/vnite](https://github.com/ximu3/vnite) — original project created by ximu3.

### 🛠️ Fixes

- **Region-locked Steam games can now be identified by Steam App ID.** Previously, region-restricted titles could be found by name search but returned an "invalid ID" error when added or scraped by their Steam App ID. Metadata, screenshots, header images, and existence checks now probe multiple store regions (matching the behaviour of name search), so these games resolve correctly. (fixes [ximu3/vnite#681](https://github.com/ximu3/vnite/issues/681))

---

### 🛠️ 修复

- **区域锁 Steam 游戏现在可以按 Steam App ID 识别。** 此前区域限制的游戏能按名称搜索到，但按 Steam App ID 添加或刮削时会报“无效 ID”。现在元数据、截图、头图与存在性检查都会尝试多个商店区服（与按名搜索行为一致），这类游戏可正确识别。（修复 [ximu3/vnite#681](https://github.com/ximu3/vnite/issues/681)）
