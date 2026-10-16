<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NRadioGroup,
  NRadioButton,
  NButton,
  NAlert,
  NSwitch,
  useMessage,
} from "naive-ui";
import {
  FlaskConical,
  Check,
  FileText,
  List,
  ArrowUpRight,
} from "lucide-vue-next";
import type {
  Monitor,
  MonitorInput,
  ExtractResult,
  Rule,
} from "../../../shared/types";
import { api, formatInterval } from "../api";

const props = defineProps<{ show: boolean; monitor?: Monitor | null }>();
const emit = defineEmits<{ "update:show": [boolean]; saved: [Monitor] }>();
const message = useMessage();
const form = reactive<MonitorInput>({
  name: "",
  url: "",
  mode: "TEXT",
  selector: "",
  ignoreSelectors: [],
  intervalMinutes: 30,
  enabled: true,
});
const ignoreText = ref(""),
  preview = ref<ExtractResult | null>(null),
  testError = ref(""),
  saveError = ref("");
const testing = ref(false),
  saving = ref(false),
  testedSignature = ref("");
const intervalHours = ref<number | null>(0),
  intervalMinutes = ref<number | null>(30);
const selectedInterval = computed(
  () => (intervalHours.value ?? 0) * 60 + (intervalMinutes.value ?? 0),
);
const validInterval = computed(
  () =>
    Number.isInteger(intervalHours.value ?? 0) &&
    (intervalHours.value ?? 0) >= 0 &&
    (intervalHours.value ?? 0) <= 24 &&
    Number.isInteger(intervalMinutes.value ?? 0) &&
    (intervalMinutes.value ?? 0) >= 0 &&
    (intervalMinutes.value ?? 0) <= 60 &&
    selectedInterval.value >= 1 &&
    selectedInterval.value <= 1500,
);
const rule = computed<Rule>(() => ({
  url: form.url.trim(),
  mode: form.mode,
  selector: form.selector.trim(),
  ...(form.mode === "TEXT"
    ? {
        ignoreSelectors: ignoreText.value
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      }
    : {
        ...(form.titleSelector?.trim()
          ? { titleSelector: form.titleSelector.trim() }
          : {}),
        ...(form.linkSelector?.trim()
          ? { linkSelector: form.linkSelector.trim() }
          : {}),
      }),
}));
const signature = computed(() => JSON.stringify(rule.value));
const testCurrent = computed(
  () => testedSignature.value === signature.value && !!preview.value,
);
const validRule = computed(() => {
  try {
    const u = new URL(form.url);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !!form.selector.trim()
    );
  } catch {
    return false;
  }
});
watch(
  () => props.show,
  (show) => {
    if (!show) return;
    const m = props.monitor;
    Object.assign(form, {
      name: m?.name ?? "",
      url: m?.url ?? "",
      mode: m?.mode ?? "TEXT",
      selector: m?.selector ?? "",
      titleSelector: m?.titleSelector ?? "",
      linkSelector: m?.linkSelector ?? "",
      intervalMinutes: m?.intervalMinutes ?? 30,
      enabled: m?.enabled ?? true,
    });
    ignoreText.value = m?.ignoreSelectors?.join("\n") ?? "";
    const interval = m?.intervalMinutes ?? 30;
    intervalHours.value = Math.min(24, Math.floor(interval / 60));
    intervalMinutes.value = interval - intervalHours.value * 60;
    preview.value = null;
    testError.value = "";
    saveError.value = "";
    testedSignature.value = "";
  },
  { immediate: true },
);
watch(signature, () => {
  testError.value = "";
});
async function testRule() {
  const requestedSignature = signature.value,
    requestedRule = rule.value;
  testing.value = true;
  testError.value = "";
  preview.value = null;
  try {
    const result = await api.test(requestedRule);
    if (signature.value === requestedSignature) {
      preview.value = result;
      testedSignature.value = requestedSignature;
    }
  } catch (error) {
    testError.value = (error as Error).message;
  } finally {
    testing.value = false;
  }
}
async function save() {
  if (!validInterval.value) {
    saveError.value = "检查间隔至少为 1 分钟，最多为 24 小时 60 分钟。";
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    const input: MonitorInput = {
      ...rule.value,
      name: form.name.trim(),
      intervalMinutes: selectedInterval.value,
      enabled: form.enabled,
    };
    const result = props.monitor
      ? await api.update(props.monitor.id, {
          ...input,
          ignoreSelectors: input.ignoreSelectors ?? [],
          titleSelector: input.titleSelector ?? "",
          linkSelector: input.linkSelector ?? "",
        })
      : await api.create(input);
    message.success(props.monitor ? "规则已保存" : "监控已创建，正在建立基线");
    emit("update:show", false);
    emit("saved", result);
  } catch (error) {
    saveError.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <NDrawer
    :show="show"
    :width="560"
    :close-on-esc="!saving && !testing"
    :mask-closable="!saving && !testing"
    :on-update:show="(value) => emit('update:show', value)"
    class="monitor-editor"
  >
    <NDrawerContent
      :title="monitor ? '编辑监控' : '新建监控'"
      closable
      :native-scrollbar="false"
    >
      <p class="drawer-intro">圈定关注的内容，下一次变化交给哨兵。</p>
      <NForm
        label-placement="top"
        :show-require-mark="false"
        @submit.prevent="save"
      >
        <NFormItem label="监控名称" :label-props="{ for: 'monitor-name' }"
          ><NInput
            :input-props="{ id: 'monitor-name' }"
            v-model:value="form.name"
            placeholder="例如：产品更新日志"
            :maxlength="120"
            :disabled="saving"
        /></NFormItem>
        <NFormItem label="网页地址" :label-props="{ for: 'monitor-url' }"
          ><NInput
            :input-props="{ id: 'monitor-url' }"
            v-model:value="form.url"
            placeholder="https://example.com/changelog"
            :disabled="saving"
        /></NFormItem>
        <NFormItem label="关注什么">
          <NRadioGroup v-model:value="form.mode" name="mode" :disabled="saving"
            ><NRadioButton value="TEXT"
              ><FileText :size="14" /> 区域变化</NRadioButton
            ><NRadioButton value="LIST"
              ><List :size="14" /> 列表新增条目</NRadioButton
            ></NRadioGroup
          >
        </NFormItem>
        <NFormItem
          :label="
            form.mode === 'TEXT' ? '区域 CSS 选择器' : '列表项 CSS 选择器'
          "
          :label-props="{ for: 'monitor-selector' }"
          ><NInput
            :input-props="{ id: 'monitor-selector' }"
            v-model:value="form.selector"
            :placeholder="
              form.mode === 'TEXT' ? '.changelog-content' : '.article-list > li'
            "
            :disabled="saving"
        /></NFormItem>
        <p class="field-help">
          {{
            form.mode === "TEXT"
              ? "必须恰好选中一个区域，只提取可见文本。"
              : "每个匹配元素代表一个条目，仅检测历史未见的详情链接。"
          }}
        </p>
        <NFormItem
          v-if="form.mode === 'TEXT'"
          label="排除子元素（可选，每行一个 CSS 选择器）"
          :label-props="{ for: 'monitor-ignore' }"
          ><NInput
            :input-props="{ id: 'monitor-ignore' }"
            v-model:value="ignoreText"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder=".update-time"
            :disabled="saving"
        /></NFormItem>
        <template v-else>
          <NFormItem
            label="标题选择器（可选，相对于列表项）"
            :label-props="{ for: 'monitor-title' }"
            ><NInput
              :input-props="{ id: 'monitor-title' }"
              v-model:value="form.titleSelector"
              placeholder="如 .title；留空使用条目文本"
              :disabled="saving"
          /></NFormItem>
          <NFormItem
            label="链接选择器（可选，相对于列表项）"
            :label-props="{ for: 'monitor-link' }"
            ><NInput
              :input-props="{ id: 'monitor-link' }"
              v-model:value="form.linkSelector"
              placeholder="如 a；留空自动寻找唯一链接"
              :disabled="saving"
          /></NFormItem>
        </template>
        <div class="preview-section">
          <div class="section-toolbar">
            <h3>提取预览</h3>
            <NButton
              :loading="testing"
              :disabled="!validRule || saving"
              @click="testRule"
              ><template #icon><FlaskConical :size="16" /></template
              >{{ testing ? "正在采集" : "测试规则" }}</NButton
            >
          </div>
          <NAlert
            v-if="testError"
            type="error"
            :show-icon="false"
            role="alert"
            >{{ testError }}</NAlert
          >
          <div v-else-if="preview && testCurrent" class="preview-result">
            <p class="preview-success">
              <Check :size="15" /> 匹配 {{ preview.matchCount }} 个{{
                preview.mode === "TEXT" ? "区域" : "条目"
              }}
            </p>
            <pre v-if="preview.mode === 'TEXT'">{{ preview.text }}</pre>
            <ol v-else class="preview-list">
              <li v-for="item in preview.items" :key="item.key">
                <a :href="item.url" target="_blank" rel="noopener noreferrer"
                  >{{ item.title }}<ArrowUpRight :size="13" /></a
                ><small>{{ item.url }}</small>
              </li>
            </ol>
          </div>
          <p v-else class="preview-placeholder">
            {{
              testing
                ? "正在打开网页并等待内容稳定…"
                : preview
                  ? "规则已修改，请重新测试提取结果。"
                  : "先测试规则，确认提取到的内容正是你关心的。"
            }}
          </p>
          <p class="field-help">
            测试会真实访问网页，不保存快照，也不改变正式基线。
          </p>
        </div>
        <NFormItem label="自定义检查间隔">
          <div class="interval-fields">
            <label for="monitor-interval-hours"
              >小时
              <NInputNumber
                v-model:value="intervalHours"
                :input-props="{
                  id: 'monitor-interval-hours',
                  'aria-label': '间隔小时',
                }"
                :min="0"
                :max="24"
                :precision="0"
                :disabled="saving"
              />
            </label>
            <label for="monitor-interval-minutes"
              >分钟
              <NInputNumber
                v-model:value="intervalMinutes"
                :input-props="{
                  id: 'monitor-interval-minutes',
                  'aria-label': '间隔分钟',
                }"
                :min="0"
                :max="60"
                :precision="0"
                :disabled="saving"
              />
            </label>
            <p :class="{ 'interval-error': !validInterval }">
              {{
                validInterval
                  ? `每 ${formatInterval(selectedInterval)} 检查一次`
                  : "总间隔至少为 1 分钟"
              }}
            </p>
          </div>
        </NFormItem>
        <p class="field-help">实际执行时间会随机错开约 5～10 秒。</p>
        <div class="switch-row">
          <div>
            <strong>自动监控</strong>
            <p>开启后服务端按时检查，关闭后仍可手动检查。</p>
          </div>
          <NSwitch
            v-model:value="form.enabled"
            aria-label="本任务自动监控"
            :disabled="saving"
          />
        </div>
        <NAlert v-if="saveError" type="error" class="save-error" role="alert">{{
          saveError
        }}</NAlert>
      </NForm>
      <template #footer
        ><div class="drawer-footer">
          <span>首次采集建立基线，只有有效变化才会推送 ntfy。</span
          ><NButton
            :disabled="saving || testing"
            @click="emit('update:show', false)"
            >取消</NButton
          ><NButton
            type="primary"
            :loading="saving"
            :disabled="
              !form.name.trim() || !validRule || !validInterval || testing
            "
            @click="save"
            >{{ monitor ? "保存修改" : "创建监控" }}</NButton
          >
        </div></template
      >
    </NDrawerContent>
  </NDrawer>
</template>
