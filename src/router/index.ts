import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import { areaRoutes, hasPermission } from '@/app/registry'
import AppShell from '@/layouts/AppShell.vue'
import { authStore } from '@/stores/authStore'
import AcceptInviteView from '@/views/auth/AcceptInviteView.vue'
import ForgotPasswordView from '@/views/auth/ForgotPasswordView.vue'
import RegisterView from '@/views/auth/RegisterView.vue'
import ResetPasswordView from '@/views/auth/ResetPasswordView.vue'
import VerifyEmailView from '@/views/auth/VerifyEmailView.vue'
import ForbiddenView from '@/views/ForbiddenView.vue'
import HomeView from '@/views/HomeView.vue'
import LoginView from '@/views/LoginView.vue'

/**
 * Route table: the public screens (login, registration, e-mail verification,
 * password reset, invitation acceptance), then one authenticated tree under the
 * app shell. Feature areas contribute their own children through
 * `src/app/registry.ts`, so nothing here knows about individual areas.
 *
 * The token-carrying public screens read their one-time token from `?token=…`
 * on the link the mail carries; a hand-pasted token is accepted as well.
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { public: true, title: '登录' }
  },
  {
    path: '/register',
    name: 'register',
    component: RegisterView,
    meta: { public: true, title: '注册' }
  },
  {
    path: '/verify-email',
    name: 'verify-email',
    component: VerifyEmailView,
    meta: { public: true, title: '邮箱验证' }
  },
  {
    path: '/forgot-password',
    name: 'forgot-password',
    component: ForgotPasswordView,
    meta: { public: true, title: '忘记密码' }
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: ResetPasswordView,
    meta: { public: true, title: '重置密码' }
  },
  {
    path: '/accept-invite',
    name: 'accept-invite',
    component: AcceptInviteView,
    meta: { public: true, title: '接受邀请' }
  },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', name: 'home', component: HomeView, meta: { title: '概览', section: 'me' } },
      ...areaRoutes,
      { path: 'forbidden', name: 'forbidden', component: ForbiddenView, meta: { title: '无权访问' } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } }
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

/**
 * A session may only be resumed once the refresh token has been rotated, so the
 * guard awaits the same single-flight bootstrap the app start kicks off. This
 * runs before the public branch as well: a stored session must redirect away
 * from a public screen even on a hard reload, while a visitor without a refresh
 * token is not delayed at all. Deep links survive the detour: the login screen
 * replays `?redirect=`.
 */
router.beforeEach(async (to) => {
  if (!authStore.isAuthenticated.value && authStore.hasRefreshToken()) {
    await authStore.bootstrap()
  }

  if (to.meta.public === true) {
    if (!authStore.isAuthenticated.value) return true
    // A signed-in visitor on a public screen follows its deep link, but never a
    // protocol-relative URL or another public screen (that would bounce them
    // straight back). The route table decides what is public.
    const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : ''
    if (redirect.startsWith('/') && !redirect.startsWith('//') && router.resolve(redirect).meta.public !== true) {
      return { path: redirect }
    }
    return { name: 'home' }
  }

  if (!authStore.isAuthenticated.value) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (!hasPermission(to.meta.permission, authStore.permissions.value)) {
    return { name: 'forbidden', query: { from: to.fullPath } }
  }

  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · 团队用户控制台` : '团队用户控制台'
})
