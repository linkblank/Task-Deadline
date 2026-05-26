const { Plugin, PluginSettingTab, Setting, MarkdownView } = require("obsidian");
const { WidgetType, EditorView, Decoration } = require("@codemirror/view");

const DEFAULT_SETTINGS = {
  remainingText: "剩余{days}天",
  expiredText: "已过期{days}天",
  dueTodayText: "今天截止",
  showCompleted: true, // 是否显示已完成任务的剩余天数
  sourceModeDecoration: true,
};

function getDaysDifference(dateString) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(dateString);
  targetDate.setHours(0, 0, 0, 0);
  const diffTime = targetDate - today;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function getRemainingText(days, settings) {
  if (days === 0) return settings.dueTodayText;
  if (days > 0) return settings.remainingText.replace("{days}", days);
  return settings.expiredText.replace("{days}", Math.abs(days));
}

// 判断任务是否已完成（通过复选框或Markdown标记）
function isTaskCompleted(li) {
  // 方法1：查找复选框并检查checked状态
  const checkbox = li.querySelector('input[type="checkbox"]');
  if (checkbox && checkbox.checked) return true;
  // 方法2：检查文本中是否包含 [x] 或 [X]（防止某些视图未渲染复选框）
  const text = li.textContent;
  if (/^\s*-\s*\[\s*x\s*\]/i.test(text)) return true;
  return false;
}

// 实时预览/阅读模式：处理DOM元素
function processTaskItem(li, settings) {
  // 根据设置决定是否跳过已完成任务
  if (!settings.showCompleted && isTaskCompleted(li)) return;

  const existingSpan = li.querySelector(".task-remaining-days");
  if (existingSpan) existingSpan.remove();

  const dateRegex = /📅\s*(\d{4}-\d{2}-\d{2})/;
  const text = li.textContent;
  const match = dateRegex.exec(text);
  if (!match) return;

  const dateStr = match[1];
  const daysDiff = getDaysDifference(dateStr);
  const remainingText = getRemainingText(daysDiff, settings);
  const span = document.createElement("span");
  span.className = `task-remaining-days ${daysDiff > 0 ? "remaining-positive" : daysDiff < 0 ? "remaining-negative" : "remaining-zero"}`;
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

// 源码模式：Widget 类
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

// 源码模式：编辑器扩展（增加已完成任务过滤）
function sourceModeExtension(plugin) {
  return EditorView.decorations.compute(["doc"], (state) => {
    if (!plugin.settings.sourceModeDecoration) return Decoration.none;
    const decorations = [];
    const doc = state.doc;
    const dateRegex = /📅\s*(\d{4}-\d{2}-\d{2})/;
    const taskRegex = /^\s*-\s*\[\s*[x ]?\s*\]/i;
    const completedRegex = /^\s*-\s*\[\s*x\s*\]/i; // 匹配已完成任务

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const lineText = line.text;
      if (!taskRegex.test(lineText)) continue;

      // 根据设置决定是否跳过已完成任务
      if (!plugin.settings.showCompleted && completedRegex.test(lineText))
        continue;

      const match = dateRegex.exec(lineText);
      if (!match) continue;

      const daysDiff = getDaysDifference(match[1]);
      const remainingText = getRemainingText(daysDiff, plugin.settings);
      const className =
        daysDiff > 0
          ? "remaining-positive"
          : daysDiff < 0
            ? "remaining-negative"
            : "remaining-zero";
      const widget = new RemainingDaysWidget(remainingText, className);
      const deco = Decoration.widget({
        widget: widget,
        side: 1, // 放在行尾
      });
      decorations.push(deco.range(line.to));
    }
    return Decoration.set(decorations);
  });
}

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

class TaskRemainingDaysSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "任务剩余天数插件设置" });
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
    new Setting(containerEl)
      .setName("今天截止文本")
      .setDesc("截止日期为今天时显示的文本")
      .addText((text) =>
        text
          .setPlaceholder("今天截止")
          .setValue(this.plugin.settings.dueTodayText)
          .onChange(async (value) => {
            this.plugin.settings.dueTodayText = value;
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
  }
}

module.exports = TaskRemainingDaysPlugin;
