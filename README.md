# dsh-web-search-free

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的免费优先搜索 provider。

注册进 `ctx.web`，实现 `WebSearchProvider` 契约。DSH 自带的 `web-search-deepseek` / `web-search-exa` / `web-search-perplexity` 都是单后端，这个是多后端自动降级。

> 包名是 `dsh-web-search-free-kg`（npm 上 `dsh-web-search-free` 已被他人占用），仓库名保持 `dsh-web-search-free`。

## 降级链

```
exa-mcp   →  bing-html  →  ddg-html  →  serpapi(有额度才用)
   免费          免费          免费            250次/月
```

免费后端能出结果就绝不碰付费的。

## 安装

```bash
dsh plugin --profile <你的 profile> add <本目录路径或 GitHub 地址>
```

装上后在 dsh 配置里选中它：

```yaml
# 或者用环境变量
DSH_WEB_SEARCH_PROVIDER=free
```

## 它做了什么

实现了 DSH 的 `WebSearchProvider`：

```ts
export interface WebSearchProvider {
  readonly id: string
  available(): boolean          // 禁止发网络请求
  search(request, signal?): Promise<WebSearchResult>
}
```

三条硬约束（都守住）：

1. **`available()` 是纯静态判断**，不发任何网络请求 —— 契约明确要求
2. **全失败抛 `WebError`**，不返回空数组 —— 空数组会被上层当成"搜到了但没结果"
3. **每个后端的失败互相隔离** —— 一个挂了继续试下一个

## 几个实现细节（踩过的坑）

### DuckDuckGo 需要三样东西

1. **代理** —— 国内直连必然超时
2. **浏览器 UA** —— `free-search/1.0` 这种短 UA 会被打回 202 验证码页
3. **解包重定向链接** —— DDG 的结果链接是

   ```
   //duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2F&rut=...
   ```

   协议相对 + `uddg` 参数包装，直接按 `http` 前缀过滤会把所有结果丢掉。

### 代理实现是零依赖的

Node 没有 `getproxies()`，所以自己做了三层：

1. `FREE_SEARCH_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` 环境变量
2. Windows 注册表 `ProxyEnable` + `ProxyServer`
3. 都没有 → 直连

检测到代理后用 Node 内置的 `http` / `https` / `tls` 手写 `CONNECT` 隧道，**不引入 `undici` 或任何新依赖**。

> 代价是承担约 200 行传输代码的维护责任。
> 已知边界：只处理 `https://` 目标，只支持字符串请求体。

### Bing 的"兜底推荐卡"

必空查询时，Bing 返回的 `.b_algo` 里塞的是无关推荐卡（不是"没找到"提示）。所以除了页面提示和 cite 检查，还加了一条保守规则：**满 10 张卡片且标题/摘要全不含查询词 → 判为 empty**。

这条规则有误判风险：真实查询如果 10 条结果恰好都不含查询词，会被误判。但它只在满 10 张时生效，短结果集不受影响。

## 测试

```bash
npm install          # 只装 typescript
npx tsc -p tsconfig.json --noEmit    # 类型检查
node test/provider-smoke.mjs         # 端到端
node test/href-proxy.mjs             # href 解码 + UA + 代理
node test/contract.mjs               # 契约约束
node test/chinese-smoke.mjs          # 中文编码
```

## 结构

```
.
├── src/
│   ├── index.ts              # name / inject / apply
│   ├── provider.ts           # WebSearchProvider 实现
│   ├── backends.ts           # 三个后端 + 代理隧道
│   └── node-builtins.d.ts    # 最小 Node 类型声明（避免加 @types/node）
├── test/
├── cordis.patch.yml          # 注册进 dsh 的 bundle patch
└── package.json
```

## 依赖

- Node 18+
- **运行时零外部依赖**（只有 `typescript` 作为开发依赖）

## 许可

MIT
