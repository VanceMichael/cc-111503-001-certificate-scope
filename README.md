# 车辆认证查询的产品适用范围采集

Node.js 资料接收项目。当前版本保留来源原件，提供单次预览（preview）和按进货清单的收件采集（collect）：把搜索候选、证书当期状态与附件适用配置连成闭合依据，区分确实覆盖、不覆盖与资料不足。项目的用途是让接收方区分“能打开来源”和“已经可靠取得可交付资料”。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证当前预览、真实来源交互、收件存储及采集结论的边界语义。`npm run demo` 启动本地来源，执行一次真实预览和一次真实收件，输出取得的内容、逐行结论和证据摘要后自动关闭。`npm run acceptance` 检查收件扩展接口 `collect(source, store)`，必须与现有测试一同通过，不能把新增检查改成跳过。

Linux 环境可用 `docker build -t certificate-scope:local .` 预装依赖，然后 `docker run --rm --network none certificate-scope:local` 验证底座。`docker run --rm --network none certificate-scope:local npm run demo` 展示真实预览与收件。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。收件检查在同一环境运行，不靠预设结果文本代替产品执行。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储，preview 本身不会声称已经完成业务接收。

`src/collect.mjs` 是收件入口：搜索分页闭合后才承认候选集合；每份证书的详情与全部声明附录必须落在同一 revision 上，409 或版本不一致时整份重取，不拼跨版本证明；型号别名按来源的精确别名表 trim 后映射；排除条件任一键值全匹配才排除，空配置不是通配。suspended 候选的适用范围与状态照常留存证据，但不能令 coverage 成为 covered；未闭合且可能影响判断的候选令结论为 unknown。返回的 `records` 逐行给出 covered / not-covered / unknown 及证据引用，unknown 行同时进入 `pending` 留待人工，候选级问题进入 `diagnostics`。coverage 仅说明证书附件的适用范围，不构成上牌许可。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。
