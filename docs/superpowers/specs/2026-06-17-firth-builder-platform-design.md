# Firth Builder Platform — 设计 Spec(v1)

> 日期:2026-06-17
> 状态:设计已收敛,待 review → 转实现 plan。
> 关系:本 spec 是 firth v1 的产品/技术设计。架构总览见 [`ARCHITECTURE.md`](../../../ARCHITECTURE.md),产品概览见 [`README.md`](../../../README.md)。

---

## 0. 一句话

**firth 是一个面向 agent 和 developer 的 builder platform:用户建账户、建项目,每个项目编排三种第三方基础资源(Neon DB / S3 storage / Fly.io compute),并叠加统一 secret 管理、运行时 observability、故障分析。firth 不自营资源、不赚资源差价——它做的是 integration + 治理服务。**

---

## 1. 定位与边界(已锁定的产品决策)

| 决策 | 取值 | 理由 / 后果 |
|---|---|---|
| **角色** | 第三方资源的 **orchestrator**,不是 reseller | 资源成本透传,firth 不赚资源差价;产品是 integration + 治理 |
| **核心** | 控制/integration 是产品,资源是载体 | 「不坐进资源,就托不住 secret、观测不到 observe/recover」——资源是凭证咽喉的必要载体 |
| **账户归属** | firth 为 **account-of-record**,成本透传 | firth 用自己配置的 Neon/S3/Fly key 在自己 org 下 provision。凭证 by construction 流经 firth |
| **资源三件套** | Neon(DB) / S3(storage) / **Fly.io**(compute) | Fly 用现有 credits,适合产品验证。Railway 已弃用 |
| **hosting** | 托管 SaaS(资源层无法自托管) | 因 provider 账户 + secret 在 firth 侧;信任靠治理层可取证性 + 合规,不靠自托管 |
| **branching** | DB 原生 branch;storage 共享 bucket;compute redeploy 还原 | 见 §6 |
| **凭证路径** | **B:provisioning 中心 + env 注入**,但留 secret 缝 | 先跑通;缝保证将来可平滑升级到运行时代发(C),不重写 app |
| **firth 后端** | **InsForge**(linked project `0662c2ef-202a-4feb-8267-5501b3b60037`) | 见 §2 |

**显式 v1 范围外**:F 故障分析(只做数据采集,不做 triage 逻辑)、运行时凭证代发(C)、多 branch 并行 compute、完整计费(计量先打桩)。

---

## 2. 架构:两层 + InsForge 映射

**两个绝不能blur的层:**
- **firth-as-tenant-of-InsForge** — firth 自己的 auth / 元数据 / API / 网站,跑在 InsForge 上。
- **firth-provisions-for-users** — Neon / S3 / Fly,由 adapter 编排,开在 firth 自己的 provider org 下。

**三个面 + 一个脑:**
- **控制面 API(脑)** — 跑在 **InsForge compute**(容器服务)。唯一权威。
- **firth 官网 / dashboard** — 跑在 **InsForge sites**。
- **firth-cli** — 给 agent/dev 的接口;和 Web 一样只是控制面 API 的客户端。

**子系统 → InsForge 映射:**

| firth 子系统 | 跑在 InsForge 的什么上 | 自定义代码 |
|---|---|---|
| A 控制面 API | **compute** + **Postgres**(元数据) | 编排逻辑(saga) |
| firth 账户 | **auth**(Google / GitHub OAuth) | ≈0 |
| 元数据库 | **Postgres + RLS** | schema migrations |
| C 资源 adapter | compute 内 | **Neon / S3 / Fly 三个 adapter(核心)** |
| D secret 缝 | 密文存 **firth DB**;KEK 放 **InsForge secrets / compute env** | 缝接口 + scoped env 生成 |
| E Observability | **logs** + Postgres 表 | observe/ hook 上报 + 关联 |
| 计量 | **scheduled jobs**(v1 打桩) | 计量逻辑(后续) |
| B firth-cli | — | 薄客户端 + skill 拉取 |
| Web dashboard | **sites** | 前端 |

**真正从零写的四块:① 三个 provider adapter;② 编排 + secret 缝;③ Observe 关联;④ firth-cli + Web。** 其余是 InsForge 配置 + migration。

**两类 branch,同名不同层,始终分开称呼:**
- `firth-meta branch` — InsForge backend branch,测 firth 自己后端改动。
- `user-project branch` — firth 给用户项目创建的 Neon branch(见 §6)。

**两个 Fly org,不相干:** firth 给用户开的 Fly app 跑在 firth 自己的 Fly org;InsForge compute 底层用的 Fly 是另一个 org。

---

## 3. 元数据 schema(InsForge Postgres,`public`,带 RLS,owner = `auth.uid()`)

```
projects(id, owner=auth.uid(), name, status, created_at)

branches(id, project_id, name, parent_branch_id?, is_default,
         neon_branch_ref?,        -- 每 branch 独立的 Neon 分支(DB 是唯一真隔离的资源)
         status, created_at)

resources(id, project_id, kind∈{neon|s3|fly},
          provider_ref jsonb,     -- neon project id / bucket name / fly app id
          status, created_at)     -- project 级:S3 bucket、Fly app 全 branch 共享

secrets(id, project_id, branch_id?,  -- branch_id=null → project 级(S3/Fly);非空 → 该 branch 的 DB 连接串
        name, ciphertext, nonce, kek_version, expires_at?, created_at)
```

**要点:DB 是唯一真隔离的资源**(`branches.neon_branch_ref`);S3/Fly 挂 `resources`(project 级),全 branch 共享 → 落地 §6 的 branching 语义。

**RLS:** 每张表按 `owner = auth.uid()`(或经 `project_id` join 到 owner)隔离。多租户凭证库,RLS 是命门,见 §8 测试。

---

## 4. 统一 provider adapter 接口

三个 provider 必须长一个样,编排才能统一。这是要从零写的核心代码。

```ts
interface ProviderAdapter {
  kind: 'neon' | 's3' | 'fly'
  branchModel: 'native' | 'shared' | 'redeploy'
  provision(projectId): ResourceHandle              // 建基础资源
  destroy(handle): void                             // 补偿回滚用
  createBranch(handle, name, parentRef?): BranchRef | null   // neon=原生; s3/fly=null(no-op)
  mintCredentials(handle, branchRef?): SecretBundle // 连接凭证;DB 随 branch 变
  readUsage(handle): UsageSnapshot                  // 计量(v1 打桩)
}
```

| | provision | branchModel | mintCredentials |
|---|---|---|---|
| **Neon** | firth Neon org 下建 project/DB | `native`(API 建 branch) | 该 branch 连接串 |
| **S3** | firth S3 下建 bucket | `shared`(createBranch→null) | bucket scoped 凭证 |
| **Fly** | firth Fly org 下建 app | `redeploy`(无 branch) | (compute 消费别人的凭证) |

> Fly Machines API / Neon API / S3 API 的具体调用,在写 adapter 时用 context7 拉当时官方文档。

---

## 5. Secret 管理与加密策略

**secret 缝**:`firth secrets <project> [--branch]` 是唯一出口——控制面服务端解密、TLS 返回、CLI 写本地 `.env` 或注入 Fly deploy。app/agent **绝不硬编码**连接串。今天 = env 注入(B);将来换运行时代发(C)= 这个 endpoint 改 mint 短期凭证,接口不变。

**加密(不可妥协):** firth DB 握着每个客户的资源连接凭证 = 全网最肥攻击目标。
- secret 行**应用层 AEAD 加密**;
- **KEK 不在这张 DB 里**,放 InsForge secrets / compute env(密钥与数据分离);
- `kek_version` 列支持轮换;
- 任何日志**永不出现明文**(测试断言)。

**两类 secret 分开存:**
- firth **master provider key**(Neon/S3/Fly 三把)→ InsForge secrets / compute env(运营密钥,少、极少轮换)。
- 每 project/branch 的**派生连接凭证** → 加密存 firth DB。

---

## 6. Branching 语义

| 资源 | branch 行为 | 隔离? |
|---|---|---|
| DB(Neon) | 原生 COW branch,每 branch 独立 | ✅ 真隔离 |
| storage(S3) | 全 branch 共享同一 bucket | ❌ 不隔离 |
| compute(Fly) | 不 branch;redeploy 还原到当前状态 | n/a(可重建) |

**branch ≈ Neon DB branch + 该 branch 专属 secret(连接串)+ 同 bucket + 可重部署的 compute。**

**诚实 caveat(留洞、不假装覆盖):** storage 共享 → branch **对 S3 没有隔离**,agent 在 branch 里删/改对象会影响主 branch,丢弃 branch 救不回。**「branch = undo」只对 DB 成立,storage 的恢复需另一条路**(S3 versioning,或 observe + 合成补偿动作)——这是 v1 留的已知洞,恢复机制是后续工作。

**派生 UX 后果:** compute 只有一个 Fly app(project 级),「在某 branch 部署」= 把它重新指向该 branch 的 DB 再 deploy。**同一时刻只服务一个 branch 的 compute**,切 branch 靠 redeploy。多 branch 并行 compute 是 v2。

---

## 7. 三条关键流程

**Flow 1 `firth project create <name>`** — 错误处理重心:
```
CLI →(InsForge auth token)→ 控制面
  1. insert projects + 默认 branches(main, is_default)
  2. 并发 fan-out provision:Neon→createBranch(main); S3; Fly
  3. 每个 mintCredentials → AEAD 加密 → insert secrets
       (DB 连接串=branch 级挂 main;S3/Fly=project 级)
  4. 返回 project;CLI 拉 neon/s3/fly/firth-integration skills 到 local
```
**Saga:** 跨 3 个外部 provider 多步 provision,部分失败是常态。每步落 `resources.status`、可幂等重试;失败则 `--resume` 续做或补偿性 destroy 回滚。**绝不留孤儿资源、绝不谎报成功。**

**Flow 2 `firth branch create <name> [--from main]`**:insert branches → `NeonAdapter.createBranch`(原生)→ mint 该 branch DB 连接串(加密入库)。S3/Fly no-op。

**Flow 3 `firth deploy [--branch]`**:CLI 打包源码 → 控制面经 secret 缝取该 branch SecretBundle → 注入 Fly secrets → `fly deploy` → 记一条 side-effect 给 Observe。

---

## 8. Observe 关联(E 的 v1)

两条按 `(project, branch)` 对齐的事件流:
- **agent 动作** — 已有 `observe/` hook(改了啥文件/跑了啥命令/碰了啥凭证)→ 控制面 ingest 端点;
- **资源副作用** — deploy / 迁移 / provision / 用量 / provider 日志。

存 `actions` / `side_effects` 表 → 串成 project/branch 时间线 → dashboard 渲染。**「agent 动作 ↔ 资源副作用」的串联是区别于 LangSmith/Langfuse 的单位。** F(故障分析)是这之上的后续层,不在 v1。

---

## 9. 安全

- firth 是凭证 honeypot → §5 加密策略不可妥协。
- RLS 隔离多租户(命门)。
- master provider key 与派生凭证分离存储。
- 提供给用户的 PII / secret 永不入日志。

---

## 10. 测试边界

- **adapter 契约测试** — 三个 adapter 跑同一套 `ProviderAdapter` 接口测试(provider sandbox 或 mock HTTP)。
- **saga 测试** — 模拟「provider 2 失败」→ 断言回滚后无孤儿。
- **secret 缝测试** — 加密→存→取→解密往返 + KEK 轮换 + 断言日志无明文。
- **RLS 测试** — 用户 A 读不到用户 B 的 projects/secrets。
- 复用并扩展 `observe/selftest.py`。

---

## 11. 建议 build order(实现 plan 细化)

1. **地基** — InsForge auth + 元数据 schema(§3)+ RLS + 控制面 API 骨架(compute)。
2. **secret 缝 + 加密**(§5)— 先于任何资源,因为所有资源都要经它。
3. **第一个 adapter(Neon)+ Flow 1 单资源 + saga**(§4/§7)。
4. **扩到 S3 + Fly**(三件套 provision)。
5. **branching**(§6)。
6. **firth-cli + skill 拉取 + Flow 3 deploy**。
7. **Observe 关联 + dashboard**(§8)。
8. Web dashboard 其余 + 计量打桩。

---

## 12. 开放项 / 风险

- storage 无隔离的恢复洞(§6)——v2 解决。
- account-of-record 让 firth 持 master 凭证 = 高攻击面,§5 缓解但不消除。
- Fly credits 耗尽后的 compute 成本结构(产品验证期可接受)。
