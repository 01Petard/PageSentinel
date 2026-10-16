<script setup lang="ts">
import { computed, onUnmounted, ref, useId } from "vue";
import {
  AlignLeft,
  Columns2,
  Copy,
  Check,
  Plus,
  Minus,
  Sparkles,
} from "lucide-vue-next";
import type { DiffPart } from "../../../shared/types";
import { buildDiffView } from "../diff-view";

const props = defineProps<{ parts: DiffPart[] }>();
const view = ref<"unified" | "split">("unified");
const model = computed(() => buildDiffView(props.parts));
const groupId = useId(),
  copyState = ref("复制新增");
let copyTimer: ReturnType<typeof setTimeout>;
async function copyAdditions() {
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(model.value.additions.join("\n"));
    copyState.value = "已复制";
  } catch {
    copyState.value = "复制失败";
  }
  copyTimer = setTimeout(() => {
    copyState.value = "复制新增";
  }, 2500);
}
onUnmounted(() => clearTimeout(copyTimer));
</script>

<template>
  <section
    class="addition-review"
    :class="{ 'deletion-only': !model.addedCount }"
    aria-label="本次新增内容"
  >
    <div class="addition-heading">
      <div class="addition-title">
        <span class="addition-icon"
          ><Sparkles v-if="model.addedCount" :size="17" /><Minus
            v-else
            :size="17"
        /></span>
        <h3>新增内容</h3>
        <span class="addition-count">{{ model.addedCount }} 行</span>
      </div>
      <button
        v-if="model.addedCount"
        class="copy-additions"
        type="button"
        :title="
          copyState === '复制失败'
            ? '请手动选择新增内容复制'
            : '复制全部新增内容'
        "
        @click="copyAdditions"
      >
        <Check v-if="copyState === '已复制'" :size="14" /><Copy
          v-else
          :size="14"
        />{{ copyState }}
      </button>
    </div>
    <div v-if="model.addedCount" class="addition-blocks">
      <pre v-for="(block, index) in model.additions" :key="index">{{
        block
      }}</pre>
    </div>
    <p v-else class="deletion-note">本次仅有删除，没有新增内容。</p>
    <p v-if="model.addedCount" class="addition-note">
      仅列出本次新增的行，修改后的内容也包含在内。
    </p>
  </section>
  <section class="change-diff" aria-label="完整内容变化对比">
    <div class="diff-toolbar">
      <div class="diff-caption">
        <strong>内容对比</strong
        ><span class="diff-count added"
          ><Plus :size="12" />{{ model.addedCount }}</span
        ><span class="diff-count removed"
          ><Minus :size="12" />{{ model.removedCount }}</span
        >
      </div>
      <fieldset class="diff-view-switch">
        <legend class="sr-only">对比查看方式</legend>
        <label :class="{ selected: view === 'unified' }"
          ><input
            v-model="view"
            class="sr-only"
            type="radio"
            :name="groupId"
            value="unified"
          /><AlignLeft :size="14" />统一查看</label
        ><label :class="{ selected: view === 'split' }"
          ><input
            v-model="view"
            class="sr-only"
            type="radio"
            :name="groupId"
            value="split"
          /><Columns2 :size="14" />并排查看</label
        >
      </fieldset>
    </div>
    <div
      class="diff-viewport"
      tabindex="0"
      role="region"
      :aria-label="view === 'split' ? '并排内容对比' : '统一内容对比'"
    >
      <div v-if="view === 'unified'" class="unified-diff" key="unified">
        <div class="unified-heading">
          <span>前</span><span>后</span
          ><span>变化前后 · 红色删除，绿色新增</span>
        </div>
        <div
          v-for="(row, index) in model.unified"
          :key="index"
          class="unified-line"
          :class="row.kind"
        >
          <span class="line-number">{{ row.beforeNumber }}</span
          ><span class="line-number">{{ row.afterNumber }}</span
          ><span class="diff-sign" aria-hidden="true">{{
            row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "
          }}</span
          ><code>{{ row.text || " " }}</code>
        </div>
      </div>
      <div v-else class="split-diff" key="split">
        <div class="split-heading">
          <span><span class="before-dot"></span>变化前</span
          ><span><span class="after-dot"></span>变化后</span>
        </div>
        <div v-for="(row, index) in model.split" :key="index" class="split-row">
          <div
            class="split-cell"
            :class="{ removed: row.before?.changed, gap: !row.before }"
          >
            <template v-if="row.before"
              ><span class="line-number">{{ row.before.number }}</span
              ><span class="diff-sign" aria-hidden="true">{{
                row.before.changed ? "−" : " "
              }}</span
              ><code>{{ row.before.text || " " }}</code></template
            >
          </div>
          <div
            class="split-cell"
            :class="{ added: row.after?.changed, gap: !row.after }"
          >
            <template v-if="row.after"
              ><span class="line-number">{{ row.after.number }}</span
              ><span class="diff-sign" aria-hidden="true">{{
                row.after.changed ? "+" : " "
              }}</span
              ><code>{{ row.after.text || " " }}</code></template
            >
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
