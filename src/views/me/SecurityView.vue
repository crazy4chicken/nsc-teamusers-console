<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDivider,
  NForm,
  NFormItem,
  NGrid,
  NInput,
  NSpace,
  NSpin,
  NTag,
  NText,
  useMessage
} from 'naive-ui'

import { messageForError } from '@/api/errors'
import {
  beginTotpEnrollment,
  copyText,
  disableTotpWithCode,
  downloadBackupCodes,
  issueBackupCodes,
  mfaCodeError,
  mfaErrorMessage,
  totpCodeError,
  verifyTotpEnrollment,
  type TotpEnrollment
} from '@/api/mfa'
import { exportAccount } from '@/api/me'
import PasskeysView from './PasskeysView.vue'

/**
 * Two-factor settings. `/me/export` is the only endpoint that reports whether
 * TOTP is active; the pending enrolment lives in component state and the two
 * one-time secrets (the TOTP secret and the backup codes) exist only in memory
 * until the user copies or downloads them.
 */

type Busy = '' | 'load' | 'enroll' | 'confirm' | 'disable' | 'regenerate'

const message = useMessage()

const busy = ref<Busy>('load')
const loadError = ref<string | null>(null)
const totpEnabled = ref(false)

const enrollment = ref<TotpEnrollment | null>(null)
const enrollmentCode = ref('')

const disabling = ref(false)
const disableCode = ref('')

const regenerating = ref(false)
const regeneratePassword = ref('')

/** Shown once: the service never returns these codes again. */
const backupCodes = ref<string[]>([])
const backupCodesOrigin = ref<'enroll' | 'regenerate' | null>(null)

async function load(): Promise<void> {
  busy.value = 'load'
  loadError.value = null
  try {
    const exported = await exportAccount()
    totpEnabled.value = exported.totp_enabled
  } catch (error) {
    loadError.value = messageForError(error)
  } finally {
    busy.value = ''
  }
}

async function startEnrollment(): Promise<void> {
  busy.value = 'enroll'
  try {
    enrollment.value = await beginTotpEnrollment()
    enrollmentCode.value = ''
    backupCodes.value = []
    backupCodesOrigin.value = null
    message.success('已生成密钥，请在验证器中添加后输入验证码完成启用。')
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    busy.value = ''
  }
}

async function confirmEnrollment(): Promise<void> {
  const invalid = totpCodeError(enrollmentCode.value)
  if (invalid) {
    message.warning(invalid)
    return
  }
  busy.value = 'confirm'
  try {
    backupCodes.value = await verifyTotpEnrollment(enrollmentCode.value)
    backupCodesOrigin.value = 'enroll'
    totpEnabled.value = true
    enrollment.value = null
    enrollmentCode.value = ''
    message.success('两步验证已启用。')
  } catch (error) {
    message.error(mfaErrorMessage(error, 'totp_confirm'))
  } finally {
    busy.value = ''
  }
}

async function confirmDisable(): Promise<void> {
  const invalid = mfaCodeError(disableCode.value)
  if (invalid) {
    message.warning(invalid)
    return
  }
  busy.value = 'disable'
  try {
    await disableTotpWithCode(disableCode.value)
    totpEnabled.value = false
    disabling.value = false
    disableCode.value = ''
    backupCodes.value = []
    backupCodesOrigin.value = null
    message.success('两步验证已停用，原备用码同时失效。')
  } catch (error) {
    message.error(mfaErrorMessage(error, 'totp_disable'))
  } finally {
    busy.value = ''
  }
}

async function confirmRegenerate(): Promise<void> {
  if (!regeneratePassword.value) {
    message.warning('请输入当前密码。')
    return
  }
  busy.value = 'regenerate'
  try {
    backupCodes.value = await issueBackupCodes(regeneratePassword.value)
    backupCodesOrigin.value = 'regenerate'
    regenerating.value = false
    regeneratePassword.value = ''
    message.success('已生成新的备用码，旧备用码立即失效。')
  } catch (error) {
    message.error(mfaErrorMessage(error, 'backup_codes'))
  } finally {
    busy.value = ''
  }
}

function cancelEnrollment(): void {
  enrollment.value = null
  enrollmentCode.value = ''
}

function cancelDisable(): void {
  disabling.value = false
  disableCode.value = ''
}

function cancelRegenerate(): void {
  regenerating.value = false
  regeneratePassword.value = ''
}

async function copyValue(value: string, label: string): Promise<void> {
  const copied = await copyText(value)
  if (copied) message.success(`${label}已复制。`)
  else message.warning('当前浏览器不允许自动复制，请手动选择文本复制。')
}

async function copyBackupCodes(): Promise<void> {
  await copyValue(backupCodes.value.join('\n'), '备用码')
}

function dismissBackupCodes(): void {
  backupCodes.value = []
  backupCodesOrigin.value = null
  message.info('备用码已从页面移除，之后无法再次查看。')
}

onMounted(() => {
  void load()
})
</script>

<template>
  <NSpin :show="busy === 'load'">
    <NSpace vertical :size="16">
      <NAlert v-if="loadError" type="error" title="安全设置加载失败">
        <NSpace align="center" :size="12">
          <NText>{{ loadError }}</NText>
          <NButton size="small" @click="load">重试</NButton>
        </NSpace>
      </NAlert>

      <NCard title="两步验证（TOTP）" :bordered="false">
        <template #header-extra>
          <NTag :type="totpEnabled ? 'success' : 'default'" size="small">
            {{ totpEnabled ? '已启用' : '未启用' }}
          </NTag>
        </template>

        <NAlert type="info" :show-icon="false" class="notice">
          启用后，登录时需要输入验证器应用生成的 6 位动态验证码；停用或恢复访问时可以使用备用码。
        </NAlert>

        <template v-if="!totpEnabled && !enrollment">
          <NButton type="primary" :loading="busy === 'enroll'" @click="startEnrollment">
            启用两步验证
          </NButton>
        </template>

        <template v-else-if="enrollment">
          <NForm label-placement="left" :label-width="96">
            <NFormItem label="密钥">
              <NSpace vertical :size="8">
                <NSpace align="center" :size="12">
                  <NText code strong class="secret">{{ enrollment.groupedSecret }}</NText>
                  <NButton size="tiny" @click="copyValue(enrollment.secret, '密钥')">复制密钥</NButton>
                </NSpace>
                <NSpace align="center" :size="12">
                  <NButton size="tiny" @click="copyValue(enrollment.otpauthUrl, '配置链接')">
                    复制配置链接
                  </NButton>
                  <NText depth="3" class="hint">部分验证器应用支持导入链接。</NText>
                </NSpace>
              </NSpace>
            </NFormItem>
            <NFormItem label="验证码">
              <NInput
                v-model:value="enrollmentCode"
                placeholder="验证器显示的 6 位数字"
                :maxlength="6"
                :allow-input="(value: string) => /^\d*$/.test(value)"
              />
            </NFormItem>
            <NFormItem label=" ">
              <NSpace>
                <NButton
                  type="primary"
                  :loading="busy === 'confirm'"
                  :disabled="busy !== ''"
                  @click="confirmEnrollment"
                >
                  确认并启用
                </NButton>
                <NButton :disabled="busy !== ''" :loading="busy === 'enroll'" @click="startEnrollment">
                  重新生成密钥
                </NButton>
                <NButton quaternary :disabled="busy !== ''" @click="cancelEnrollment">
                  取消
                </NButton>
              </NSpace>
            </NFormItem>
          </NForm>

          <NAlert type="warning" :show-icon="false">
            请把上方密钥添加到验证器应用，也可以导入配置链接，然后填写应用生成的验证码。
          </NAlert>
        </template>

        <template v-else>
          <NSpace v-if="!disabling && !regenerating">
            <NButton :disabled="busy !== ''" @click="regenerating = true">重新生成备用码</NButton>
            <NButton type="error" secondary :disabled="busy !== ''" @click="disabling = true">
              停用两步验证
            </NButton>
          </NSpace>

          <NForm v-else-if="disabling" label-placement="left" :label-width="96">
            <NFormItem label="验证码">
              <NInput v-model:value="disableCode" placeholder="6 位动态验证码或 16 位备用码" />
            </NFormItem>
            <NFormItem label=" ">
              <NSpace>
                <NButton type="error" :loading="busy === 'disable'" @click="confirmDisable">
                  确认停用
                </NButton>
                <NButton quaternary :disabled="busy !== ''" @click="cancelDisable">取消</NButton>
              </NSpace>
            </NFormItem>
            <NText depth="3" class="hint">停用后备用码一并失效，登录将不再要求动态验证码。</NText>
          </NForm>

          <NForm v-else label-placement="left" :label-width="96">
            <NFormItem label="当前密码">
              <NInput
                v-model:value="regeneratePassword"
                type="password"
                show-password-on="click"
                placeholder="用于确认身份"
                autocomplete="current-password"
              />
            </NFormItem>
            <NFormItem label=" ">
              <NSpace>
                <NButton type="primary" :loading="busy === 'regenerate'" @click="confirmRegenerate">
                  生成新备用码
                </NButton>
                <NButton quaternary :disabled="busy !== ''" @click="cancelRegenerate">取消</NButton>
              </NSpace>
            </NFormItem>
            <NText depth="3" class="hint">生成后旧的备用码全部失效。</NText>
          </NForm>
        </template>

        <template v-if="backupCodes.length > 0">
          <NDivider />
          <NAlert type="warning" title="备用码仅显示这一次">
            请立即复制或下载保存，离开或刷新页面后将无法再次查看。
            {{ backupCodesOrigin === 'enroll' ? '每个备用码可代替动态验证码使用一次。' : '' }}
          </NAlert>
          <NGrid class="codes" :cols="2" :x-gap="16" :y-gap="6">
            <NText v-for="code in backupCodes" :key="code" code>{{ code }}</NText>
          </NGrid>
          <NSpace>
            <NButton @click="copyBackupCodes">复制全部</NButton>
            <NButton @click="downloadBackupCodes(backupCodes)">下载为文本</NButton>
            <NButton quaternary @click="dismissBackupCodes">我已保存</NButton>
          </NSpace>
        </template>
      </NCard>

      <PasskeysView />
    </NSpace>
  </NSpin>
</template>

<style scoped>
.notice {
  margin-bottom: 16px;
}

.secret {
  font-size: 15px;
  letter-spacing: 1px;
}

.codes {
  margin: 12px 0 16px;
  padding: 12px;
  background: #fafafc;
  border: 1px dashed #d9d9d9;
  border-radius: 4px;
}

.hint {
  font-size: 12px;
}
</style>
