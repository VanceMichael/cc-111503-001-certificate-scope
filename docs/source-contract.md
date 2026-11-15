# 来源接口与资料语义

搜索命中仅表示候选。modelAliases 是精确别名表，trim 后按表映射，不按子串或品牌合并。scope 的 models 是包含集合，excludeConfigurations 的任一键值全匹配则排除；空电池配置不是通配。证书详情含 revision、status、appendices 列表；附件请求必须带 revision，409 表示所持详情已过期。每条附录的 revision 必须一致且所有声明附录取得后才能声称覆盖集合完整。status=active 仅表示证书当期有效，不代表指定车辆可上牌。无候选、全部不适用、候选未闭合应分开。

## 收件器扩展接口

现有 `src/intake.mjs` 导出 `preview(source, store)`，只做预览。收件器入口为新增的 `collect(source, store)`，由调用方负责创建和关闭来源及 Inbox。`npm run acceptance` 调用这一入口。返回的 `records` 是可正式交付资料，不把未确认片段放进该集合；特殊业务的 pending 和 diagnostics 独立返回。原始证据通过 Inbox 保存，正式记录应含证据引用。接口不规定内部架构，允许增加模块和持久表，但不能移除原预览或更改来源语义。

## 可观察边界

- 型号同名但电池配置被排除
- 一个适用候选与一个不适用候选并存
- 搜索中途详情变更且旧附录拒绝领取
- 缺失附录不能得出不覆盖
- 同一清单内别名映射到同一车型仍保留原始行身份

## 公开的结果字段

`acceptance/collection.test.mjs` 给出当前集成方使用的结果字段及最小示例，说明的是输出契约而非内部处理步骤。除这些示例外，以上来源语义也属于功能范围，不能靠场景名称分支返回固定答案。`status` 仅在对应资料闭合且可靠取得时为 complete。
