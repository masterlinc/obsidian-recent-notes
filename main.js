'use strict';

/*
 * 最近修改 (recent-notes)
 * 在侧边栏中按文件修改时间由新到旧列出笔记。
 * 纯 CommonJS，无需构建。
 */

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Keymap,
  TFile,
  moment,
} = require('obsidian');

const VIEW_TYPE = 'recent-notes-view';

const DEFAULT_SETTINGS = {
  limit: 60,
  groupByDate: true,
  showFolder: true,
  useUpdatedField: true,
  ignoreFolders: '_NoteCompanion/Templates',
  openedOnce: false,
};

// 笔记前置元数据中可能表示“最后更新”的字段
const UPDATED_KEYS = ['updated', 'modified', 'last_modified', 'lastModified'];

/* ---------------------------------------------------------------- 工具函数 */

function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function normalizeFolder(path) {
  return String(path || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

/** 判断文件路径是否位于被忽略的文件夹中 */
function isIgnored(path, ignoreList) {
  if (!ignoreList) return false;
  const folders = String(ignoreList)
    .split('\n')
    .map(normalizeFolder)
    .filter(Boolean);
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (path === folder || path.startsWith(folder + '/')) return true;
  }
  return false;
}

/** 相对时间，中文，超出 30 天显示日期 */
function formatTime(ts) {
  const diff = Date.now() - ts;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < 0) return moment(ts).format('YYYY-MM-DD');
  if (diff < minute) return '刚刚';
  if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';

  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function formatFullTime(ts) {
  const d = new Date(ts);
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

/** 解析前置元数据里的日期值 */
function parseDateValue(raw) {
  if (raw == null) return 0;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;

  let text = String(raw).trim();
  if (!text) return 0;
  const linkMatch = text.match(/^\[\[([^\]]+)\]\]$/);
  if (linkMatch) text = linkMatch[1];

  const parsed = moment(
    text,
    [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD HH:mm',
      'YYYY-MM-DD',
      'YYYY/MM/DD',
      moment.ISO_8601,
    ],
    true
  );
  return parsed.isValid() ? parsed.valueOf() : 0;
}

/** 笔记的“最后修改时间”：文件时间与前置元数据 updated 取较新者 */
function effectiveTime(app, file, useUpdatedField) {
  const base = file.stat ? file.stat.mtime : 0;
  if (!useUpdatedField) return base;

  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache && cache.frontmatter;
  if (!frontmatter) return base;

  let best = 0;
  for (let i = 0; i < UPDATED_KEYS.length; i++) {
    const key = UPDATED_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      const ts = parseDateValue(frontmatter[key]);
      if (ts > best) best = ts;
    }
  }
  return best > base ? best : base;
}

/** 日期分组标签 */
function groupLabel(ts, now) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (ts >= startOfToday) return '今天';
  if (ts >= startOfToday - day) return '昨天';
  if (ts >= startOfToday - 7 * day) return '近 7 天';
  if (ts >= startOfToday - 30 * day) return '近 30 天';
  return '更早';
}

/* -------------------------------------------------------------------- 视图 */

class RecentNotesView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.query = '';
    this.searchInput = null;
    this.listEl = null;
    this.summaryEl = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '最近修改';
  }

  getIcon() {
    return 'history';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('recent-notes-container');

    const toolbar = root.createDiv({ cls: 'recent-notes-toolbar' });
    this.searchInput = toolbar.createEl('input', {
      cls: 'recent-notes-search',
      type: 'search',
      attr: { placeholder: '搜索笔记…', spellcheck: 'false' },
    });
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });

    this.summaryEl = root.createDiv({ cls: 'recent-notes-summary' });
    this.listEl = root.createDiv({ cls: 'recent-notes-list' });

    this.renderList();
  }

  async onClose() {
    this.searchInput = null;
    this.listEl = null;
    this.summaryEl = null;
  }

  /** 取排序后的条目列表 [{file, ts}]（已过滤忽略目录） */
  getFiles() {
    const settings = this.plugin.settings;
    const useUpdated = settings.useUpdatedField;
    let entries = this.app.vault
      .getMarkdownFiles()
      .filter((f) => !isIgnored(f.path, settings.ignoreFolders))
      .map((f) => ({ file: f, ts: effectiveTime(this.app, f, useUpdated) }));

    const q = this.query;
    if (q) {
      entries = entries.filter(
        (e) =>
          e.file.basename.toLowerCase().includes(q) ||
          e.file.path.toLowerCase().includes(q)
      );
    }

    entries.sort((a, b) => b.ts - a.ts);

    const limit = Math.max(1, Number(settings.limit) || 60);
    return entries.slice(0, limit);
  }

  renderList() {
    const listEl = this.listEl;
    if (!listEl) return;
    listEl.empty();

    const entries = this.getFiles();
    const settings = this.plugin.settings;
    const now = new Date();

    if (this.summaryEl) {
      if (this.query) {
        this.summaryEl.setText(entries.length + ' 条匹配');
      } else {
        const todayCount = entries.filter((e) => groupLabel(e.ts, now) === '今天').length;
        this.summaryEl.setText(
          '按修改时间排序 · 最近 ' + entries.length + ' 篇' + (todayCount ? ' · 今天 ' + todayCount + ' 篇' : '')
        );
      }
    }

    if (entries.length === 0) {
      listEl.createDiv({
        cls: 'recent-notes-empty',
        text: this.query ? '没有匹配的笔记' : '还没有笔记',
      });
      return;
    }

    let currentGroup = null;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const file = entry.file;
      const ts = entry.ts;

      if (settings.groupByDate) {
        const label = groupLabel(ts, now);
        if (label !== currentGroup) {
          currentGroup = label;
          listEl.createDiv({ cls: 'recent-notes-group', text: label });
        }
      }

      this.createItem(listEl, file, ts);
    }
  }

  createItem(parent, file, ts) {
    const item = parent.createDiv({ cls: 'recent-note-item' });
    item.setAttr('data-path', file.path);
    item.setAttr('title', file.path + '\n修改时间：' + formatFullTime(ts));
    item.tabIndex = 0;

    const main = item.createDiv({ cls: 'recent-note-main' });
    main.createDiv({ cls: 'recent-note-title', text: file.basename });

    if (this.plugin.settings.showFolder) {
      const folderPath = file.parent && file.parent.path ? file.parent.path : '/';
      const folder = folderPath === '/' || folderPath === '' ? '根目录' : folderPath;
      main.createDiv({ cls: 'recent-note-folder', text: folder });
    }

    item.createDiv({ cls: 'recent-note-time', text: formatTime(ts) });

    item.addEventListener('click', (evt) => {
      const mod = Keymap.isModEvent(evt);
      this.app.workspace.getLeaf(mod || false).openFile(file);
    });

    item.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        this.app.workspace.getLeaf(false).openFile(file);
      }
    });

    item.addEventListener('mouseover', (evt) => {
      this.app.workspace.trigger('hover-link', {
        event: evt,
        source: 'recent-notes',
        hoverParent: this,
        targetEl: item,
        linktext: file.path,
        sourcePath: '',
      });
    });

    if (this.app.dragManager) {
      item.draggable = true;
      item.addEventListener('dragstart', (evt) => {
        this.app.dragManager.onDragStart(evt, { file, source: VIEW_TYPE });
      });
    }

    return item;
  }
}

/* -------------------------------------------------------------------- 设置 */

class RecentNotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('显示数量')
      .setDesc('列表中最多显示多少篇笔记（1–500）')
      .addText((text) =>
        text
          .setPlaceholder('60')
          .setValue(String(this.plugin.settings.limit))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.limit = Math.min(n, 500);
              await this.plugin.saveSettings();
              this.plugin.refreshViews();
            }
          })
      );

    new Setting(containerEl)
      .setName('按日期分组')
      .setDesc('分为 今天 / 昨天 / 近 7 天 / 近 30 天 / 更早')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.groupByDate).onChange(async (value) => {
          this.plugin.settings.groupByDate = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName('显示所在文件夹')
      .setDesc('在标题下方显示笔记所在的文件夹路径')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showFolder).onChange(async (value) => {
          this.plugin.settings.showFolder = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName('优先使用笔记中的更新时间')
      .setDesc('笔记前置元数据里若有 updated / modified 字段，取它与文件修改时间中较新的一个来排序')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useUpdatedField).onChange(async (value) => {
          this.plugin.settings.useUpdatedField = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName('忽略的文件夹')
      .setDesc('每行一个文件夹路径，其中的笔记不会出现在列表里（例如模板目录）')
      .addTextArea((area) => {
        area
          .setPlaceholder('_NoteCompanion/Templates')
          .setValue(this.plugin.settings.ignoreFolders)
          .onChange(
            debounce(async (value) => {
              this.plugin.settings.ignoreFolders = value;
              await this.plugin.saveSettings();
              this.plugin.refreshViews();
            }, 500)
          );
        area.inputEl.rows = 3;
      });
  }
}

/* -------------------------------------------------------------------- 插件 */

class RecentNotesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new RecentNotesView(leaf, this));

    this.addRibbonIcon('history', '最近修改的笔记', () => this.activateView());

    this.addCommand({
      id: 'open-view',
      name: '打开最近修改视图',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'open-latest',
      name: '打开最近修改的那篇笔记',
      callback: () => this.openLatest(),
    });

    this.addSettingTab(new RecentNotesSettingTab(this.app, this));

    const refreshSoon = debounce(() => this.refreshViews(), 500);
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) refreshSoon();
      })
    );
    this.registerEvent(this.app.vault.on('create', () => refreshSoon()));
    this.registerEvent(this.app.vault.on('delete', () => refreshSoon()));
    this.registerEvent(this.app.vault.on('rename', () => refreshSoon()));

    // 首次启用时自动打开一次，之后不再打扰
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.openedOnce) {
        this.settings.openedOnce = true;
        this.saveSettings();
        this.activateView();
      }
    });
  }

  onunload() {
    // 视图由 Obsidian 负责清理；这里不需要 detach
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  openLatest() {
    const useUpdated = this.settings.useUpdatedField;
    let latest = null;
    let latestTs = -1;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => !isIgnored(f.path, this.settings.ignoreFolders));
    for (let i = 0; i < files.length; i++) {
      const ts = effectiveTime(this.app, files[i], useUpdated);
      if (ts > latestTs) {
        latestTs = ts;
        latest = files[i];
      }
    }
    if (!latest) return;
    this.app.workspace.getLeaf(false).openFile(latest);
  }

  refreshViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (let i = 0; i < leaves.length; i++) {
      const view = leaves[i].view;
      if (view && typeof view.renderList === 'function') view.renderList();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = RecentNotesPlugin;
