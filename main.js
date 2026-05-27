const { Plugin, PluginSettingTab, Setting, MarkdownView } = require("obsidian");
const { WidgetType, EditorView, Decoration } = require("@codemirror/view");

const DEFAULT_SETTINGS = {
  remainingText: "剩余{days}天",
  expiredText: "已过期{days}天",
  dueTodayText: "今天截止",
  showCompleted: true,
  sourceModeDecoration: true,
  // 精确倒计时
  enablePreciseTiming: true,
  preciseThresholdDays: 1,
  // 紧急色阈值（小时）
  urgentThresholdHours: 8,
};

// ========== 日期解析（支持时间） ==========
function parseDateString(dateStr) {
  let normalized = dateStr.trim();
  let year,
    month,
    day,
    hour = 0,
    minute = 0;
  if (normalized.includes(" ")) {
    const [datePart, timePart] = normalized.split(" ");
    const [y, m, d] = datePart.split("-").map(Number);
    const [h, min] = timePart.split(":").map(Number);
    year = y;
    month = m - 1;
    day = d;
    hour = h || 0;
    minute = min || 0;
  } else {
    const [y, m, d] = normalized.split("-").map(Number);
    year = y;
    month = m - 1;
    day = d;
  }
  return new Date(year, month, day, hour, minute, 0);
}

function getExactDiffMs(dateStr) {
  const now = new Date();
  const target = parseDateString(dateStr);
  return target - now;
}

function hasTimePart(dateStr) {
  return dateStr.includes(" ");
}

// ========== 智能文本生成 ==========
function getSmartRemainingText(dateStr, settings) {
  const diffMs = getExactDiffMs(dateStr);
  const absMs = Math.abs(diffMs);
  const absDays = absMs / (1000 * 60 * 60 * 24);
  const hasTime = hasTimePart(dateStr);

  if (
    settings.enablePreciseTiming &&
    hasTime &&
    absDays <= settings.preciseThresholdDays
  ) {
    const hours = Math.floor(absMs / (1000 * 60 * 60));
    const minutes = Math.floor((absMs % (1000 * 60 * 60)) / (1000 * 60));
    if (diffMs >= 0) {
      if (hours === 0 && minutes === 0) return settings.dueTodayText;
      if (hours === 0) return `剩余${minutes}分钟`;
      if (minutes === 0) return `剩余${hours}小时`;
      return `剩余${hours}小时${minutes}分`;
    } else {
      if (hours === 0 && minutes === 0) return `刚刚过期`;
      if (hours === 0) return `已过期${minutes}分钟`;
      if (minutes === 0) return `已过期${hours}小时`;
      return `已过期${hours}小时${minutes}分`;
    }
  } else {
    const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (days === 0) return settings.dueTodayText;
    if (days > 0) return settings.remainingText.replace("{days}", days);
    return settings.expiredText.replace("{days}", Math.abs(days));
  }
}

// 保留原函数（兼容性，实际未使用）
function getRemainingText(days, settings) {
  if (days === 0) return settings.dueTodayText;
  if (days > 0) return settings.remainingText.replace("{days}", days);
  return settings.expiredText.replace("{days}", Math.abs(days));
}

// ========== 通用辅助函数 ==========
function isTaskCompleted(li) {
  const checkbox = li.querySelector('input[type="checkbox"]');
  if (checkbox && checkbox.checked) return true;
  const text = li.textContent;
  if (/^\s*-\s*\[\s*x\s*\]/i.test(text)) return true;
  return false;
}

// 获取样式类名（支持紧急色）
function getClassName(diffMs, settings) {
  if (diffMs === 0) return "remaining-zero";
  if (diffMs < 0) return "remaining-negative";
  // diffMs > 0 未来
  const remainingHours = diffMs / (1000 * 60 * 60);
  if (remainingHours <= settings.urgentThresholdHours) {
    return "remaining-urgent";
  }
  return "remaining-positive";
}

// ========== 实时预览/阅读模式处理 ==========
function processTaskItem(li, settings) {
  if (!settings.showCompleted && isTaskCompleted(li)) return;

  const existingSpan = li.querySelector(".task-remaining-days");
  if (existingSpan) existingSpan.remove();

  const dateRegex = /📅\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?)/;
  const text = li.textContent;
  const match = dateRegex.exec(text);
  if (!match) return;

  const dateStr = match[1];
  const remainingText = getSmartRemainingText(dateStr, settings);
  const diffMs = getExactDiffMs(dateStr);
  const className = getClassName(diffMs, settings);

  const span = document.createElement("span");
  span.className = `task-remaining-days ${className}`;
  span.textContent = ` ${remainingText}`;

  const checkbox = li.querySelector('input[type="checkbox"]');
  const target = checkbox?.parentElement || li;
  target.appendChild(span);
}

function processTasks(container, settings) {
  const taskItems = container.querySelectorAll(
    'li.task-list-item, li:has(input[type="checkbox"])',
  );
  taskItems.forEach((li) => processTaskItem(li, settings));
}

// ========== 源码模式 ==========
class RemainingDaysWidget extends WidgetType {
  constructor(text, className) {
    super();
    this.text = text;
    this.className = className;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `task-remaining-days-widget ${this.className}`;
    span.textContent = ` ${this.text}`;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

function sourceModeExtension(plugin) {
  return EditorView.decorations.compute(["doc"], (state) => {
    if (!plugin.settings.sourceModeDecoration) return Decoration.none;
    const decorations = [];
    const doc = state.doc;
    const dateRegex = /📅\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?)/;
    const taskRegex = /^\s*-\s*\[\s*[x ]?\s*\]/i;
    const completedRegex = /^\s*-\s*\[\s*x\s*\]/i;

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const lineText = line.text;
      if (!taskRegex.test(lineText)) continue;
      if (!plugin.settings.showCompleted && completedRegex.test(lineText))
        continue;

      const match = dateRegex.exec(lineText);
      if (!match) continue;

      const dateStr = match[1];
      const remainingText = getSmartRemainingText(dateStr, plugin.settings);
      const diffMs = getExactDiffMs(dateStr);
      const className = getClassName(diffMs, plugin.settings);
      const widget = new RemainingDaysWidget(remainingText, className);
      const deco = Decoration.widget({
        widget: widget,
        side: 1,
      });
      decorations.push(deco.range(line.to));
    }
    return Decoration.set(decorations);
  });
}

// ========== 插件主类 ==========
class TaskRemainingDaysPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerMarkdownPostProcessor((element) => {
      setTimeout(() => processTasks(element, this.settings), 0);
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        setTimeout(() => this.refreshActiveView(), 100);
      }),
    );
    this.registerEditorExtension(sourceModeExtension(this));
    this.addSettingTab(new TaskRemainingDaysSettingTab(this.app, this));
    this.addCommand({
      id: "refresh-remaining-days",
      name: "刷新剩余天数显示",
      callback: () => this.refreshAllOpenNotes(),
    });
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshAllOpenNotes();
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view?.editor) leaf.view.editor.refresh?.();
    });
  }
  refreshActiveView() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.previewMode)
      processTasks(view.previewMode.containerEl, this.settings);
    else if (view?.editor) view.editor.refresh?.();
  }
  refreshAllOpenNotes() {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view?.previewMode)
        processTasks(leaf.view.previewMode.containerEl, this.settings);
      else if (leaf.view?.editor) leaf.view.editor.refresh?.();
    });
  }
  onunload() {
    document
      .querySelectorAll(".task-remaining-days, .task-remaining-days-widget")
      .forEach((el) => el.remove());
  }
}

// ========== 设置界面 ==========
class TaskRemainingDaysSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "任务剩余天数插件设置" });

    // 通用设置
    new Setting(containerEl)
      .setName("显示已完成任务")
      .setDesc("关闭后，已完成（打勾）的任务将不再显示剩余天数")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showCompleted)
          .onChange(async (value) => {
            this.plugin.settings.showCompleted = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("源码模式显示装饰")
      .setDesc("在纯源码编辑模式下，在任务行末尾显示剩余天数（不修改原文本）")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.sourceModeDecoration)
          .onChange(async (value) => {
            this.plugin.settings.sourceModeDecoration = value;
            await this.plugin.saveSettings();
          }),
      );

    // 文本模板
    containerEl.createEl("h3", { text: "显示文本模板" });
    new Setting(containerEl)
      .setName("剩余天数文本")
      .setDesc("使用 {days} 作为天数占位符")
      .addText((text) =>
        text
          .setPlaceholder("剩余{days}天")
          .setValue(this.plugin.settings.remainingText)
          .onChange(async (value) => {
            this.plugin.settings.remainingText = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("过期天数文本")
      .setDesc("使用 {days} 作为天数占位符")
      .addText((text) =>
        text
          .setPlaceholder("已过期{days}天")
          .setValue(this.plugin.settings.expiredText)
          .onChange(async (value) => {
            this.plugin.settings.expiredText = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl).setName("今天截止文本").addText((text) =>
      text
        .setPlaceholder("今天截止")
        .setValue(this.plugin.settings.dueTodayText)
        .onChange(async (value) => {
          this.plugin.settings.dueTodayText = value;
          await this.plugin.saveSettings();
        }),
    );

    // 精确倒计时设置
    containerEl.createEl("h3", { text: "精确倒计时设置" });
    new Setting(containerEl)
      .setName("启用精确倒计时")
      .setDesc(
        "开启后，对于带具体时间的任务，当剩余时间小于阈值时显示小时/分钟",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enablePreciseTiming)
          .onChange(async (value) => {
            this.plugin.settings.enablePreciseTiming = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("精确显示阈值（天）")
      .setDesc("剩余天数 ≤ 此值时显示小时/分钟（支持小数，如0.5表示12小时）")
      .addSlider((slider) =>
        slider
          .setLimits(0, 7, 0.5)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.preciseThresholdDays)
          .onChange(async (value) => {
            this.plugin.settings.preciseThresholdDays = value;
            await this.plugin.saveSettings();
          }),
      );

    // 紧急色设置
    containerEl.createEl("h3", { text: "紧急任务颜色" });
    new Setting(containerEl)
      .setName("紧急阈值（小时）")
      .setDesc("未来任务剩余时间 ≤ 此小时数时，显示紧急色（橙/黄）")
      .addSlider((slider) =>
        slider
          .setLimits(0, 48, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.urgentThresholdHours)
          .onChange(async (value) => {
            this.plugin.settings.urgentThresholdHours = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}

module.exports = TaskRemainingDaysPlugin;
