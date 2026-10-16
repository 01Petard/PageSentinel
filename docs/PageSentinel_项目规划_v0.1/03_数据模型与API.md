# 数据模型与 API

## 1. 五张核心表

以下为逻辑设计，字段示例用于说明职责，不是可直接执行的数据库迁移。

| 表 | 职责 | 核心字段示例 |
| --- | --- | --- |
| `monitors` | 规则和调度状态 | `id`、`name`、`url`、`mode`、`selector`、提取配置、间隔、启用状态、`next_run_at` |
| `snapshots` | TEXT 版本和必要的 LIST 采集摘要 | `id`、`monitor_id`、`content_hash`、`content_json`、`created_at` |
| `seen_items` | LIST 历史已见条目 | `monitor_id`、`item_key`、`title`、`url`、`first_seen_at` |
| `check_runs` | 每次正式检查结果 | `id`、`monitor_id`、`status`、`duration_ms`、`error_code`、`checked_at` |
| `change_events` | 有效变化和通知状态 | `id`、`monitor_id`、`type`、`detail_json`、`notification_status`、`created_at` |

`seen_items` 为 `(monitor_id, item_key)` 设置唯一约束。

TEXT 变化事件保留旧、新快照引用；LIST 事件保留本次新增条目。检查失败单独进入执行记录，不当作变化事件。

## 2. 一致性与事务

- 只有成功且有效的采集结果能够推进基线。
- 新快照、已见 Key、变化事件以及关联的检查状态需要一致提交。
- 首次采集把现有条目记入已见集合，不创建新增通知。
- 修改 URL、模式或提取规则时重建相应基线与比较状态，避免新旧规则混用。
- 网络访问和浏览器等待在事务外执行；数据库事务仅覆盖需要原子性的写入。
- 通知发送也在事务外，事件先落库，再发送、再更新通知状态。

发送成功后、状态写回前如果进程崩溃，可能重复推送一次。v0.1 接受至少一次投递，不承诺通知严格只发一次。

## 3. API 清单

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/monitors` | 查询任务列表 |
| POST | `/api/monitors` | 创建任务 |
| GET | `/api/monitors/:id` | 查询任务详情 |
| PATCH | `/api/monitors/:id` | 编辑任务、启用或暂停 |
| DELETE | `/api/monitors/:id` | 删除任务 |
| POST | `/api/monitors/test` | 测试未保存的规则 |
| POST | `/api/monitors/:id/check` | 触发一次正式检查 |
| GET | `/api/monitors/:id/events` | 查询变化历史 |
| GET | `/api/monitors/:id/checks` | 查询执行记录 |

首版采用 REST。具体请求和响应结构在实现时按提取结果确定，不引入 GraphQL。

## 4. 规则配置

| 配置 | 要求 |
| --- | --- |
| 名称 | 用户可辨识的任务名称 |
| URL | 仅支持 HTTP(S) 公开网页 |
| 模式 | TEXT 或 LIST |
| CSS 选择器 | TEXT 匹配唯一目标区域；LIST 匹配列表项 |
| TEXT 排除规则 | 可选；排除区域内指定子元素 |
| LIST 字段提取 | 从每个列表项提取标题和稳定详情链接 |
| 检查间隔 | 建议 15、30、60、180 分钟，默认 30 |
| 启用状态 | 控制是否参与自动调度 |

TEXT 配置示例：

```json
{
  "name": "软件更新日志",
  "url": "https://example.com/changelog",
  "mode": "TEXT",
  "selector": ".changelog-content",
  "ignoreSelectors": [".update-time"],
  "intervalMinutes": 30
}
```

示例域名和选择器仅用于说明配置形态。

## 5. 规则测试与结果上限

规则测试接受未保存配置，真实访问网页，返回匹配数量、提取结果或失败原因。测试与正式检查复用提取和校验逻辑，但不创建快照、不修改基线、不生成变化事件和通知。

| 限制 | 首版建议 |
| --- | --- |
| TEXT 结果 | 最多 256 KiB，按编码后的字节数判断 |
| LIST 结果 | 最多 200 条 |
| TEXT 匹配数量 | 必须为 1 |
| LIST 结果有效性 | 非空、链接有效、Key 唯一 |
| 超出上限 | 明确报错，提示缩小范围，不截断后继续比较 |

首版部署配置只需覆盖服务监听地址、持久化数据目录、浏览器执行限制和单个 ntfy 目标。具体环境变量名在实施时统一确定。
