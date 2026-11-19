# 车辆认证查询的产品适用范围采集

Node.js 资料接收项目。保留来源原件并提供单次预览，新增按进货清单领取完整依据的收件流程。项目的用途是让接收方区分“能打开来源”和“已经可靠取得可交付资料”。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证预览、收件语义及存储。`npm run demo` 启动本地来源，先执行一次真实预览，再对清单执行完整采集，输出来源原件、逐行结论及证据摘要后自动关闭。`npm run acceptance` 检查集成方公开的收件输出契约。

Linux 环境可用 `docker build -t certificate-scope:local .` 预装依赖，然后 `docker run --rm --network none certificate-scope:local` 验证底座。`docker run --rm --network none certificate-scope:local npm run demo` 展示真实采集流程。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。

## 收件流程

`src/intake.mjs` 导出 `preview(source, store)` 与 `collect(source, store)`；调用方负责创建和关闭 source 与 Inbox。

`collect` 按以下顺序为清单每一行取证：

1. 取得完整搜索候选列表。分页未闭合、请求失败或分页成环时登记为诊断，候选结论不会因此变成“不覆盖”。
2. 按 `modelAliases` 精确映射型号（trim 后整串匹配，不按子串或品牌合并）；未命中别名表的行留给人工，不猜测近似车型。
3. 对每个候选读取证书详情，用该详情的 `revision` 请求全部附录。任一转版（409 或附录正文的 revision 不一致）都会从头重新读取详情，不会把不同版本的附录拼成一份证明；多次仍不稳定则记为资料不足。
4. 逐附录解释 `scope`：`models` 为包含集合，`excludeConfigurations` 中某个对象的全部键值都与清单配置匹配才排除，空值不是通配。同一证书的附录都取自同一 revision。
5. 汇总每行的 `coverage`：`covered`（至少一份 `active` 证书的完整附件确定覆盖）、`not-covered`（候选与附件都可靠取得，但型号不适用或配置被排除）、`unknown`（搜索未闭合、候选未取回、状态无法解释或资料不足）。

每行结果含 `status`、`revisions`、`evidence`（Inbox 中原件的 id）、`citations`（实际请求的 URL 与状态码），可从结论追回到取得的页面。`status=complete` 仅当该行结论所需资料已闭合；`unknown` 行同时进入 `pending` 等待人工。`covered` 只表示进货核验所需的证书配置范围成立，不表示车辆可上牌。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。
