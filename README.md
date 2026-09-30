# nsc-teamusers-console

`nsc-teamusers-console` 是 IAM 服务 `nsc-teamusers` 的 Web 控制台：登录用户在这里维护自己的账号，
被授予管理权限的人在这里维护用户、团队与授权。它本身不含任何业务逻辑，只把服务暴露的 API
组织成界面——会话、权限判断、审计数据全部以后端为准。

技术栈是 Vue 3（`<script setup>`、TypeScript 严格模式）+ Vite + naive-ui + vue-router 4，
包管理器是 pnpm（12.x）。

## 功能特性

- 完整登录链路：密码登录、TOTP 两步验证（含备用恢复码）、通行密钥（passkey）登录，
  以及首次登录强制改密、账号待审批/锁定等异常分支。
- 未登录流程：注册、邮箱验证、忘记密码/重置密码、接受邀请；带一次性令牌的链接从
  `?token=…` 读取，手工粘贴的令牌同样接受。
- 自助区：个人资料、安全设置（改密、TOTP、通行密钥）、登录会话管理（查看并注销自己的会话）。
- 管理区：用户列表与详情、批量导入、团队、用户组、角色、授权绑定、权限登记、审计日志。
  每个页面声明所需的权限键（如 `iam:users:any`），路由守卫按后端下发的有效权限拦截。
- Bearer JWT 会话：访问令牌只存内存（10 分钟有效期），轮换式刷新令牌存 `sessionStorage`——
  刷新页面会话仍在，关掉标签页即结束；不写 `localStorage`，不依赖 Cookie。
- 统一请求层：所有请求走 `src/api/client.ts` 一个入口，自动注入 Bearer、`Idempotency-Key`、
  解析 RFC 9457 problem+json；遇到 401 全局只刷新一次并重放原请求。
- 内置开发 mock：`src/api/mock/` 在内存里实现整套 API，无需启动后端即可做 UI 开发；
  仅存在于开发构建，生产产物中不含任何 mock 代码。

## 本地开发

需要 Node.js 20+ 和 pnpm 12+（`npm i -g pnpm` 安装一次即可）：

```sh
pnpm install
pnpm dev
```

开发服务器监听 <http://localhost:5173>，并把 `/iam` 代理到后端（默认
`http://localhost:8080`，转发前剥掉 `/iam` 前缀）。把 `nsc-teamusers` 跑在 8080 端口，
即可在真实服务上开发。

没有后端时，用 mock 模式——所有 API 由内存中的 fixture 应答：

```sh
VITE_MOCK=1 pnpm dev
```

PowerShell：`$env:VITE_MOCK='1'; pnpm dev`。四个演示账号覆盖主要登录分支：

| 用户名 | 密码 | 行为 |
| --- | --- | --- |
| `admin` | `Admin-pass-1234` | 全部页面；持有 `iam:*:any` 引导权限 |
| `mfa` | `Mfa-pass-1234` | 登录进入两步验证；验证码填 `123456` 或备用码 `aaaa-bbbb-cccc-dddd` |
| `firstlogin` | `First-pass-1234` | 登录返回 `password_change_required`，走完强制改密后重新登录 |
| `viewer` | `Viewer-pass-1234` | 只读权限；管理接口返回 `403` |

mock 状态只存在内存里，整页刷新后回到初始 fixture，需要重新登录。`VITE_MOCK=1`
仅在开发构建生效：入口用动态 `import()` 加载 mock 模块，生产构建会把整个分支删掉。

## 配置

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `VITE_API_BASE` | `/iam` | 所有请求的前缀；只在反向代理前缀不同时才设置，不要带结尾斜杠 |
| `VITE_MOCK` | 空 | 设为 `1` 启用开发 mock；生产构建忽略 |

两个变量都写进 `.env.local`（从 `.env.example` 复制，已被 git 忽略）。

服务本身是**根相对**的——它不认识 `/iam`，前缀由公网反向代理加上（Strip 转发），
`/iam/auth/login` 到达后端时已是 `/auth/login`。Vite 开发服务器用同样的剥前缀重写复现这一点
（`vite.config.ts`）。

部署硬约束：服务没有 CORS 中间件、不处理 `OPTIONS` 预检，浏览器必须与 API **同源**访问
（挂在同一反向代理前缀下），否则一个跨域的 SPA 根本调不通。

通行密钥另有要求：WebAuthn 校验发生在服务端，后端的 RP ID / origin 必须与浏览器实际使用的
来源完全一致（协议 + 主机 + 端口，本机之外必须 HTTPS），否则注册与登录会在校验阶段被拒，
而密码登录不受影响。

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

已登录者访问公共页面会被送回 `/`（深链 `?redirect=` 会被重放）；未登录访问受保护页面则
跳转 `/login` 并带上 `?redirect=`；权限不足进 `/forbidden`。前端拦截只是提示性的，
最终判定永远在后端，页面仍需处理 `403 insufficient_permissions`。

## 构建与部署

```sh
pnpm build     # vue-tsc --noEmit && vite build
pnpm preview   # 本地预览生产产物
```

产物是 `dist/` 下的静态文件（`index.html` 加哈希化的 `assets/`），mock 模块不会出现在其中。
部署时把 `dist/` 交给与服务同一来源的静态站点或反向代理——再次强调同源要求：
浏览器看到的页面来源必须能直接到达 API 前缀（默认 `/iam`）。

需要桌面形态时可以用 Tauri 把 `dist/` 包成原生窗口，目前未做，仅作为可选方向记录。

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
│   └── index.ts          # 公共页面 + 挂载在 AppShell 下的功能区路由，守卫与标题
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
