# 开发与维护指南

本文是当前 v0.1 实现的唯一开发基线，替代原始分阶段规划、重复的进度记录和零散研究笔记。用户操作与启动步骤见 [README](../README.md)；未来能力单独标在 [v0.2 设计](v0.2-DESIGN.md)和[实施计划](v0.2-PLAN.md)，不计入当前功能。

## 代码地图

| 路径                                                                       | 职责                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `client/src/views/MonitorList.vue`、`MonitorDetail.vue`                    | 任务管理、当前内容、变化与执行记录                   |
| `client/src/components/MonitorEditor.vue`、`ChangeDiff.vue`                | 创建 / 编辑 / 规则测试、统一与并排差异、独立新增内容 |
| `client/src/components/NotificationCenter.vue`、`notification-delivery.ts` | 页面与系统通知、游标、跨标签去重、清空水位           |
| `server/src/app.ts`、`validation.ts`                                       | API、静态前端、请求校验、访问边界                    |
| `server/src/monitor/browser.ts`、`extractor.ts`                            | 浏览器生命周期、独立 Context、稳定提取和严格校验     |
| `server/src/monitor/comparator.ts`                                         | 文本标准化、SHA-256、行级差异、LIST 历史去重         |
| `server/src/monitor/monitor-service.ts`、`scheduler.ts`                    | 任务编排、全局并发、持久化、单项与全量刷新、到期调度 |
| `server/src/db/database.ts`、`shared/types.ts`                             | SQLite 初始化与增量升级、共享契约                    |
| `server/src/notification/ntfy.ts`                                          | 持久化待发事件、通知与重试                           |
| `Dockerfile`、`compose.yaml`、`docker/`、`deploy.sh`                       | 镜像、运行隔离、数据映射和更新                       |
| `tests/`                                                                   | 受控静态页、延迟 SPA、列表、通知接收端和回归         |

## 监控规则与不变量

一次正式检查按顺序取得执行资格、创建 Context、导航并稳定采样、校验与比较、事务保存、关闭 Context。浏览器和 ntfy 网络 IO 均不占数据库事务。

| 规则      | 当前行为                                                                        |
| --------- | ------------------------------------------------------------------------------- |
| TEXT      | 必须唯一匹配；提取可见文本，可排除子元素；最多 256 KiB（UTF-8 字节）            |
| 标准化    | 压缩空白与空行，保留数字、日期及有意义内容                                      |
| LIST      | 非空、最多 200 条；每项标题和 HTTP(S) 详情链接有效，Key 唯一                    |
| LIST 身份 | SHA-256(绝对 URL)，移除 fragment，保留查询参数，并遵循 HTML base URL            |
| LIST 事件 | 仅历史未见 Key 通知；不跟踪删除、重排或同链接的标题修改                         |
| 首次采集  | 只建立基线和已见集合，不生成变化事件                                            |
| 规则预览  | 复用真实采集；不写正式快照、基线、已见集合或执行记录                            |
| 失败      | 超时、403 / 429、空结果、选择器错误、重复 Key、超限均明确失败，不推进基线       |
| 编辑      | URL、模式、当前模式的提取规则变化重建基线；名称、间隔、启停保留基线，历史仍保留 |
| 并发修改  | 修订号隔离旧采集；任务删除或关键规则已修改时，旧结果丢弃                        |
| 任务删除  | 外键级联删除快照、历史 Key、记录、变更及未发通知；已经开始的发送可能完成        |

导航默认 20 秒、目标等待 10 秒、稳定采样最多 10 秒；每秒采样，连续两次一致视为稳定。另有总超时关闭 Context，防止页面阻塞渲染线程而永久挂起。稳定采样是启发式方法，不能保证所有 SPA 完全加载。

## 调度与结果展示

- 单实例、进程内每秒扫描到期且启用的任务；全局并发默认 2，预览、手动和自动共用；同一任务互斥，同站起始采集间隔至少 2 秒。
- 间隔为整数 1—1500 分钟，UI 使用小时 0—24、分钟 0—60。下次时间随机偏移 ±5—10 秒，含失败退避与手动刷新。
- 失败按连续次数指数退避，基础间隔封顶 24 小时后再加抖动；重启处理到期任务，不逐个补跑停机周期。
- 强制刷新全部覆盖暂停任务，等待现有执行和排队预览；期间避免自动扫描插入重复任务。每项结束后重置下次检查时间。
- 任务开关原子写入 `check_runs`，来源为 `TASK_CONTROL`，不改变采集结果或触发内容通知。已移除全局自动监控限制。
- 当前内容保留最近成功提取和 JPEG 缩略图；失败保留上次成功版本。成功提取但截图失败时显示无缩略图，不拿旧图冒充本次截图。
- 桌面缩略图与内容等宽分栏、框高 420px；手机上下排列、均高 320px。统一 / 并排差异保留各自行号，新内容单独展示。

## 持久化与通知

有效业务表为 `monitors`、`snapshots`、`seen_items`、`check_runs`、`change_events`、`monitor_previews`。`seen_items` 以任务 ID + Key 唯一；SQLite 启用 WAL、外键和 5 秒 busy timeout。当前数据库 `user_version=2`，与产品版本号分别管理；旧库可能留有不参与调度的全局设置表。

新快照、已见 Key、变化事件与检查状态在同一事务提交。ntfy 每 5 秒处理最多 20 条到期待发事件，10 秒发送超时；失败从 30 秒指数退避，最长 6 小时。中文按 UTF-8 字节限制为消息摘要；发送后写回 `SENT`。采用至少一次投递，接受发送成功、状态未落库时的重复窗口。

页面通知每 3 秒轮询 `/updates`，首轮读取历史静默；页面提醒和系统通知各自设置，浏览器间按结果 ID 去重。清空使用当前浏览器的持久化水位并同步标签页；新结果继续出现，服务端历史不删。没有 PageSentinel Web Push；后台送达使用 ntfy，当前没有邮件发送配置。

## API

前缀 `/api`，成功直接返回 JSON；错误为 `{code,message}`。时间戳为 Unix 毫秒；分页 `pageIndex` 从 1 开始，`pageSize` 默认 20、上限 100，结果为 `{items,total,pageIndex,pageSize}`。

| 方法                 | 路径                                               | 说明                                                     |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| GET                  | `/health`                                          | 健康状态、是否配置 ntfy，不返回密钥                      |
| GET / POST           | `/monitors`                                        | 列表 / 创建；创建后立即异步建立基线                      |
| GET / PATCH / DELETE | `/monitors/:id`                                    | 详情 / 编辑及启停 / 删除                                 |
| POST                 | `/monitors/test`                                   | 测试未保存规则，不创建正式检查记录                       |
| POST                 | `/monitors/:id/check`                              | 等待正式检查；重复执行返回 409                           |
| POST                 | `/monitors/check-all`                              | 202 接受批次，重复批次返回 409                           |
| GET                  | `/settings`                                        | 读取全量刷新状态                                         |
| GET                  | `/monitors/:id/current`、`/monitors/:id/thumbnail` | 当前内容 / JPEG，缺图返回 404                            |
| GET                  | `/monitors/:id/events`、`/monitors/:id/checks`     | 分页变化 / 执行记录                                      |
| GET                  | `/updates`                                         | 最近 20 条内容检查结果；`after` 游标分页，不包含任务开关 |

`Rule` 包含 `url`、`mode`、`selector`，以及可选 `ignoreSelectors`、`titleSelector`、`linkSelector`；保存任务另有 `name`、`intervalMinutes`、`enabled`。创建默认间隔 30、启用 true；PATCH 保留未提供字段，LIST 子选择器传空字符串可清除。结果为 `BASELINE / UNCHANGED / CHANGED / FAILED`；过期执行返回 `{discarded:true}`。契约以 `shared/types.ts` 和 `validation.ts` 为准。

## 配置与运行边界

| 环境变量                  | Node 默认值          | 说明                                                 |
| ------------------------- | -------------------- | ---------------------------------------------------- |
| `HOST` / `PORT`           | `127.0.0.1` / `3000` | Node 直接运行的监听地址                              |
| `PUBLIC_HOST`             | 空                   | 允许的代理访问域名，不含协议和端口；它本身不提供鉴权 |
| `DATA_DIR`                | `./data`             | Node 的 SQLite 数据目录                              |
| `CHECK_CONCURRENCY`       | `2`                  | 范围 1—4                                             |
| `NAVIGATION_TIMEOUT_MS`   | `20000`              | 导航超时                                             |
| `TARGET_TIMEOUT_MS`       | `10000`              | 等待目标超时                                         |
| `STABILITY_TIMEOUT_MS`    | `10000`              | 稳定采样总时长                                       |
| `SAMPLE_INTERVAL_MS`      | `1000`               | 采样间隔                                             |
| `NTFY_URL` / `NTFY_TOKEN` | 空                   | 完整发布 URL / 可选 Bearer Token                     |

`.env.example` 列出 Node 配置。当前 Compose 仅转入 `PUBLIC_HOST` 和 ntfy 配置，并固定容器 `HOST=0.0.0.0`、`DATA_DIR=/app/data`、默认端口 3000。其他采集参数若用于 Docker，需显式加入 Compose 的 `environment`，不能假设 `.env` 中所有变量都会自动传入。

生产采集仅 HTTP(S) 公开地址，校验主导航、重定向和子资源；禁止下载、Service Worker 和 WebSocket。默认容器额外使用 iptables 阻断私网、回环、保留 IPv4 与 IPv6，新 DNS 连接仅放行解析器原始 53 端口。应用 UID 1000、有效能力清空，Chromium 沙箱启用。内网 ntfy 受同样限制。

原生 Node 运行只有应用层地址校验，无法等价替代内核出口隔离。当前无应用账号鉴权；远程访问须另加带鉴权反向代理。Host / Origin 校验、CSP 等防护不能代替管理入口鉴权。v0.2 设计将单独处理登录凭证和私人快照的保护。

## 部署与数据维护

- 本地数据为 `./data:/app/data`，不进入 Git 或镜像。备份 / 恢复时先停止写入实例，完整复制目录，禁止只复制可能尚未合并 WAL 的主库文件。
- 从旧 `pagesentinel-data` 命名卷迁移：先停止旧容器，将其 `/app/data/.` 完整复制到空的项目 `data`，验证完整性后再按当前 Compose 启动；确认前保留旧卷，不使用 `down -v`。
- `deploy.sh` 从脚本位置确定根目录，以目录锁避免并行部署；构建完成后才替换，不自动回滚数据库。Docker 镜像源错误时旧服务保留；启动失败通过日志排查。
- 多阶段镜像仅包含后端依赖、当前平台 SQLite 绑定、编译产物与 Chromium。macOS Docker / Linux arm64 实测约 912MB，原镜像约 1.16GB；体积随平台和基础镜像变化。
- 仓库根为 PageSentinel，`output` 为忽略的验收产物；IDE 配置也以此目录为内容根。Git 提交由维护者操作。

## 验收基线

截至 2026-10-16，`npm test` 的 30 项回归通过。以 `tests/*.test.ts` 为可复现证据；受控服务真实运行 Chromium、SQLite 和 HTTP 接收端。测试工厂显式允许本机受控页面，生产入口没有关闭公共地址校验的环境开关。

| 回归组             | 关键断言                                                                  |
| ------------------ | ------------------------------------------------------------------------- |
| 首次采集、预览隔离 | 基线不通知；预览不写正式状态                                              |
| TEXT 去噪与错误    | 实质变化有 Diff；动态排除、空白不误报；匹配 / 字节限制失败明确            |
| LIST 历史去重      | 新增一次；重排 / 回归不报；base URL、query、fragment、重复和空结果        |
| 失败保护与编辑     | 403 / 429 / 超时不推进基线；旧修订丢弃；PATCH 不覆盖遗漏字段              |
| 调度与并发         | 共享并发、单任务互斥、独立启停记录、满队列批次等待、抖动与倒计时边界      |
| 重启与通知         | 基线 / Key / 待发恢复，失败重试、删除中断未开始发送、中文字节上限         |
| UI 纯逻辑与部署    | 差异行对齐、通知跨标签去重与清空、异目录部署、构建 / 启动失败保护与目录锁 |

桌面 / 手机真实操作、macOS Notifications API 显示回执、公开网页容器采集与截图、数据迁移和重启持久化已验证；本地 ntfy 真实主题已成功接收积压变化。一个月连续运行观察仍未完成。

人工演示：构建后执行 `npm run test:ui:serve -- --seed`，访问 4173。示例在临时内存库中，不进入生产数据；测试页面不代表任意第三方网站兼容性。README 截图由该演示服务生成，不含真实凭证。
