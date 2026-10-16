# 产品边界

PageSentinel 面向个人使用：配置网页提取规则，持续追踪区域文本变化和历史未见列表条目，查看证据并接收通知。保持本地优先、自部署、单实例。

## 当前可用 · v0.1

Vue / TypeScript / Naive UI，Fastify / SQLite / Playwright。任务列表、详情和规则抽屉为主要界面；只采集无需登录的公开网页。完整行为见 [README](README.md)和[开发指南](docs/DEVELOPMENT.md)，视觉以 [DESIGN.md](DESIGN.md) 为准。

## 待评审 · v0.2

新增登录身份：专用窗口登录后保存状态，以及 Cookie / storageState 导入。复用现有采集与差异流程，补齐凭证保护、失效提示、重新授权与任务绑定。拟增加身份管理入口和管理解锁，不引入多用户、计费或团队体系。

具体范围与默认选择以 [v0.2 设计](docs/v0.2-DESIGN.md)为准；实施必须等维护者评审确认。当前文档中的计划能力不能当作已发布功能。
