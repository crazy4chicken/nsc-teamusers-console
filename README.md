# nsc-teamusers-console

Nekostick 生态里，`nsc-teamusers` 是各服务共用的 IAM；本仓库是它的 Web 控制台——登录用户在这里维护自己的账号，持有管理权限的人在这里维护用户、团队与授权，与 `nsc-msghub`、`face-backend` 等服务共用同一套身份体系。

控制台不含业务逻辑：会话、权限判定、审计数据全部以后端为准，前端只把服务暴露的 API 组织成界面。技术栈为 Vue 3（`<script setup>`、TypeScript 严格模式）+ Vite + naive-ui + vue-router 4，包管理器 pnpm 12.x。

## 功能特性

- 完整登录链路：密码登录、TOTP 两步验证（含备用恢复码）、通行密钥登录，
  以及首次登录强制改密、账号待审批/锁定等异常分支。
- 未登录流程：注册、邮箱验证、忘记密码/重置密码、接受邀请；一次性令牌既从
  `?token=…` 读取，也接受手工粘贴。
- 自助区：个人资料、安全设置（改密、TOTP、通行密钥）、登录会话的查看与注销。
- 管理中心：用户列表与详情、批量导入、团队、用户组、角色、授权绑定、权限登记、审计日志。
  每个页面声明所需权限键，导航与路由守卫均按后端下发的有效权限生成和拦截。
- Bearer JWT 会话：访问令牌只存内存，轮换式刷新令牌存 `sessionStorage`——刷新页面
  会话仍在，关掉标签页即结束；不写 `localStorage`，不依赖 Cookie。
- 统一请求层 `src/api/client.ts`：自动注入 Bearer 与 `Idempotency-Key`，解析
  RFC 9457 problem+json，401 全局只刷新一次并重放原请求。
- 开发 mock 模式：内存实现整套 API，不启动后端即可做 UI 开发（见文末）。

## 本地开发

需要 Node.js 20+；pnpm 12.x 用 `npm i -g pnpm` 安装一次即可。

```sh
pnpm install
pnpm dev
```

开发服务器监听 <http://localhost:5173>，并把 `/iam` 代理到本地 IAM 服务（默认
`http://localhost:8080`，转发前剥掉前缀），因此把 `nsc-teamusers` 跑在 8080 即可在真实服务上开发。

没有后端时用 mock 模式，所有 API 由内存 fixture 应答：

```sh
TUCONSOLE_MOCK=1 pnpm dev          # PowerShell：$env:TUCONSOLE_MOCK='1'; pnpm dev
```

## 配置

两个变量都写进 `.env.local`（从 `.env.example` 复制，已被 git 忽略）：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `TUCONSOLE_API_BASE` | `/iam` | 所有请求的前缀；只在反向代理前缀不同时才设置，不带结尾斜杠 |
| `TUCONSOLE_MOCK` | 空 | 设为 `1` 启用开发 mock；生产构建忽略 |

两个部署相关的硬约束：

- **同源**：IAM 服务是根相对的（不认识 `/iam`，前缀由公网反向代理加上并 Strip 转发），
  且没有 CORS 中间件——浏览器必须与 API 同源访问（挂在同一反向代理前缀下），
  跨域的 SPA 调不通。Vite 开发服务器用同样的剥前缀重写复现这一点。
- **通行密钥来源**：WebAuthn 校验在服务端，后端的 RP ID / origin 必须与浏览器实际来源
  完全一致（协议 + 主机 + 端口，本机之外必须 HTTPS），否则注册与登录在校验阶段被拒；
  密码登录不受影响。

## 页面与路由

### 我的

| 路径 | 页面 |
| --- | --- |
| `/` | 概览 |
| `/me/profile` | 个人资料 |
| `/me/security` | 安全设置（改密、TOTP、通行密钥） |
| `/me/sessions` | 登录会话 |

### 管理中心

| 路径 | 页面 | 所需权限 |
| --- | --- | --- |
| `/admin/users` | 用户管理 | `iam:users:any` |
| `/admin/users/import` | 批量导入用户 | `iam:users:any` |
| `/admin/users/:id` | 用户详情 | `iam:users:any` |
| `/admin/teams` | 团队 | 团队域权限（`:team` 亦可） |
| `/admin/groups` | 用户组 | 同上 |
| `/admin/roles` | 角色 | 同上 |
| `/admin/bindings` | 授权绑定 | 同上 |
| `/admin/permissions` | 权限登记 | 同上 |
| `/admin/audit` | 审计日志 | `iam:audit:any` |

### 未登录流程

| 路径 | 页面 |
| --- | --- |
| `/login` | 登录（密码 / 两步验证 / 通行密钥 / 强制改密） |
| `/register` | 注册 |
| `/verify-email` | 邮箱验证 |
| `/forgot-password` | 忘记密码 |
| `/reset-password` | 重置密码（`?token=…`） |
| `/accept-invite` | 接受邀请（`?token=…`） |

已登录者访问公共页面会被送回 `/`（深链 `?redirect=` 会被重放）；未登录访问受保护页面
跳转 `/login` 并带上 `?redirect=`；权限不足进 `/forbidden`。前端拦截只是提示性的，
最终判定永远在后端，页面仍需处理 `403 insufficient_permissions`。

## 构建与部署

```sh
pnpm build     # vue-tsc --noEmit && vite build
pnpm preview   # 本地预览生产产物
```

产物是 `dist/` 下的静态文件（`index.html` 加哈希化的 `assets/`），不含任何 mock 代码。
部署时把 `dist/` 交给与 IAM 服务同一来源的静态站点或反向代理——浏览器看到的页面来源
必须能直接到达 API 前缀（默认 `/iam`）。

需要桌面形态时可以用 Tauri 把 `dist/` 包成原生窗口，本仓库未包含，仅作为可选方向记录。

## 目录结构

```text
src/
├── main.ts               # 入口：按需安装 mock、恢复会话、挂载应用
├── App.vue               # 根组件
├── env.d.ts              # Vite 环境变量类型
├── app/
│   └── registry.ts       # 聚合各功能区的 routes.ts / menu.ts，权限键匹配
├── api/
│   ├── client.ts         # 唯一请求入口：前缀、Bearer、幂等键、401 刷新重放
│   ├── auth.ts / me.ts / mfa.ts / passkeyLogin.ts
│   │                     # 认证、自助、两步验证、通行密钥的端点封装
│   ├── admin/            # 管理端点（用户、批量导入、授权、审计）
│   ├── mock/             # 开发 mock：内存状态、路由、fixture 权限
│   ├── types.ts / errors.ts / pagination.ts
│   │                     # API 类型、problem+json 错误映射、游标分页
├── router/
│   └── index.ts          # 公共页面 + 挂在 AppShell 下的功能区路由，守卫与标题
├── stores/
│   └── authStore.ts      # 会话平面：登录、刷新、登出、权限判定（模块级响应式单例）
├── layouts/
│   └── AppShell.vue      # 登录后的外壳：侧边栏按权限从注册表生成
└── views/
    ├── HomeView.vue / LoginView.vue / ForbiddenView.vue
    ├── auth/             # 注册、邮箱验证、找回密码、接受邀请（公共流程）
    ├── me/               # 自助区：资料、安全、会话
    └── admin/            # 管理区：users（列表/详情/导入）、authz（团队/用户组/角色/
                          # 绑定/权限登记）、audit；每个区自带 routes.ts 与 menu.ts
```

## 演示账号与 mock

`TUCONSOLE_MOCK=1 pnpm dev` 下四个演示账号覆盖主要登录分支：

| 用户名 | 密码 | 行为 |
| --- | --- | --- |
| `admin` | `Admin-pass-1234` | 全部页面；持有 `iam:*:any` 引导权限 |
| `mfa` | `Mfa-pass-1234` | 登录进入两步验证；验证码 `123456` 或备用码 `aaaa-bbbb-cccc-dddd` |
| `firstlogin` | `First-pass-1234` | 返回 `password_change_required`，强制改密后重新登录 |
| `viewer` | `Viewer-pass-1234` | 只读权限；管理接口返回 `403` |

mock 状态只在内存里，整页刷新即回到初始 fixture；mock 仅在开发环境生效（动态 `import()` 加载），不进入生产产物。
