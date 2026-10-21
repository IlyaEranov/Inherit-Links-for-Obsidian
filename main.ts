import {
    App,
    MarkdownView,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    getLinkpath,
    normalizePath,
} from "obsidian";

const PARENT_KEY = "parent";
const ORDER_KEY = "order";
const PARENT_RE = /(?<![\p{L}\p{N}_])@\[\[([^\[\]|#^]+)(?:[#^|][^\[\]]*)?\]\]/gu;
const CHILD_RE = /(?<![\p{L}\p{N}_])@#\[\[([^\[\]|#^]+)(?:[#^|][^\[\]]*)?\]\]/gu;

interface InheritSettings {
    sameFolder: boolean;
    showNumbers: boolean;
}

const DEFAULT_SETTINGS: InheritSettings = {
    sameFolder: false,
    showNumbers: true,
};

interface NumberInfo {
    label: string;
    order: number;
    parents: string[];
    root: boolean;
}

const fmt = (n: number) => String(n).padStart(2, "0");
const mask = (s: string) => s.replace(/[^\n]/g, " ");

const stripCode = (raw: string) =>
    raw
        .replace(/^---\r?\n[\s\S]*?\r?\n---/, mask)
        .replace(/```[\s\S]*?```/g, mask)
        .replace(/`[^`\n]*`/g, mask);

export default class InheritPlugin extends Plugin {
    settings: InheritSettings = { ...DEFAULT_SETTINGS };
    private timers = new Map<string, number>();
    private ranks = new Map<string, NumberInfo>();
    private observer: MutationObserver | null = null;
    private refreshTimer = 0;
    private decorTimer = 0;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new InheritSettingTab(this.app, this));

        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (file instanceof TFile && file.extension === "md") this.schedule(file);
            })
        );

        this.app.workspace.onLayoutReady(() => {
            this.registerEvent(
                this.app.vault.on("create", (file) => {
                    if (file instanceof TFile && file.extension === "md") {
                        this.onCreated(file);
                    }
                })
            );

            const refresh = () => this.scheduleRefresh();
            this.registerEvent(this.app.metadataCache.on("resolved", refresh));
            this.registerEvent(this.app.metadataCache.on("changed", refresh));
            this.registerEvent(this.app.vault.on("delete", refresh));
            this.registerEvent(this.app.vault.on("rename", refresh));
            this.registerEvent(
                this.app.workspace.on("layout-change", () => {
                    this.observeExplorer();
                    refresh();
                })
            );
            this.observeExplorer();
            this.refreshNumbers();
        });
    }

    onunload() {
        this.timers.forEach((t) => window.clearTimeout(t));
        window.clearTimeout(this.refreshTimer);
        window.clearTimeout(this.decorTimer);
        this.observer?.disconnect();
        document.querySelectorAll(".inherit-number").forEach((el) => el.remove());
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private schedule(file: TFile, delay = 1000) {
        window.clearTimeout(this.timers.get(file.path));
        this.timers.set(
            file.path,
            window.setTimeout(() => this.syncParents(file), delay)
        );
    }

    private async syncParents(file: TFile) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editing = view?.file?.path === file.path ? view : null;
        const raw = editing
            ? editing.editor.getValue()
            : await this.app.vault.cachedRead(file);
        const body = stripCode(raw);
        const cursor = editing
            ? editing.editor.posToOffset(editing.editor.getCursor())
            : -1;

        const wanted: string[] = [];
        const targets: TFile[] = [];
        const blocked: TFile[] = [];
        const seen = new Set<string>();
        let found = false;

        for (const m of body.matchAll(PARENT_RE)) {
            const start = m.index ?? 0;
            if (cursor > start && cursor < start + m[0].length) {
                this.schedule(file, 2000);
                return;
            }

            const name = (m[1] ?? "").trim();
            if (!name || seen.has(name)) continue;
            seen.add(name);
            found = true;

            const target = this.app.metadataCache.getFirstLinkpathDest(name, file.path);
            if (!target || target.extension !== "md") continue;

            if (this.wouldCycle(file, target)) {
                blocked.push(target);
                continue;
            }
            wanted.push(`[[${name}]]`);
            targets.push(target);
        }

        if (!found) return;

        for (const t of blocked) {
            new Notice(
                `«${file.basename}» не может быть дочерним для «${t.basename}»: получится цикл`
            );
        }
        if (wanted.length === 0) return;

        for (const t of targets) await this.ensureChildLine(t, file);

        const current = this.rawParents(file);
        if (
            current.length === wanted.length &&
            current.every((v, i) => v === wanted[i])
        ) {
            return;
        }

        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm[PARENT_KEY] = wanted;
        });
    }

    private async ensureChildLine(parentFile: TFile, child: TFile) {
        const line = `@#[[${child.basename}]]`;

        const has = (text: string) => {
            for (const m of stripCode(text).matchAll(CHILD_RE)) {
                const t = this.app.metadataCache.getFirstLinkpathDest(
                    (m[1] ?? "").trim(),
                    parentFile.path
                );
                if (t?.path === child.path) return true;
            }
            return false;
        };

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file?.path === parentFile.path) {
            const ed = view.editor;
            if (has(ed.getValue())) return;
            const last = ed.lastLine();
            const tail = ed.getLine(last);
            ed.replaceRange((tail === "" ? "" : "\n") + line + "\n", {
                line: last,
                ch: tail.length,
            });
            return;
        }

        if (has(await this.app.vault.cachedRead(parentFile))) return;

        await this.app.vault.process(parentFile, (data) => {
            if (has(data)) return data;
            const base = data.replace(/\s*$/, "");
            return base + (base === "" ? "" : "\n") + line + "\n";
        });
    }

    private async onCreated(newFile: TFile) {
        await new Promise((r) => window.setTimeout(r, 300));

        const parents: TFile[] = [];
        const children: TFile[] = [];
        const cache = this.app.metadataCache;

        for (const f of this.app.vault.getMarkdownFiles()) {
            if (f.path === newFile.path) continue;
            const links = cache.getFileCache(f)?.links;
            const points = links?.some(
                (l) => cache.getFirstLinkpathDest(getLinkpath(l.link), f.path)?.path === newFile.path
            );
            if (!points) continue;

            const body = stripCode(await this.app.vault.cachedRead(f));
            for (const m of body.matchAll(CHILD_RE)) {
                if (cache.getFirstLinkpathDest((m[1] ?? "").trim(), f.path)?.path === newFile.path) {
                    parents.push(f);
                    break;
                }
            }

            for (const m of body.matchAll(PARENT_RE)) {
                if (cache.getFirstLinkpathDest((m[1] ?? "").trim(), f.path)?.path === newFile.path) {
                    children.push(f);
                    break;
                }
            }
        }
        if (parents.length === 0 && children.length === 0) return;

        const anchor = parents[0] ?? children[0];
        if (this.settings.sameFolder && anchor) {
            await this.moveNextTo(newFile, anchor);
        }

        for (const f of children) this.schedule(f, 300);

        if (parents.length === 0) return;

        await this.app.vault.process(newFile, (data) => {
            const links = parents.map((p) => `[[${p.basename}]]`);
            const missing = links.filter((l) => !data.includes(`@${l}`));
            if (missing.length === 0) return data;

            if (data.trim() === "") {
                const list = links.map((l) => `  - "${l}"`).join("\n");
                return (
                    `---\n${PARENT_KEY}:\n${list}\n---\n` +
                    links.map((l) => `@${l}`).join("\n") +
                    "\n"
                );
            }

            return data.replace(/\s*$/, "") + "\n" + missing.map((l) => `@${l}`).join("\n") + "\n";
        });
    }

    private async moveNextTo(file: TFile, anchor: TFile) {
        const folder = anchor.parent;
        if (!folder || file.parent?.path === folder.path) return;

        const path = normalizePath(`${folder.path}/${file.name}`);
        if (this.app.vault.getAbstractFileByPath(path)) return;

        try {
            await this.app.fileManager.renameFile(file, path);
        } catch (e) {
            console.error("Inherit Links: не удалось перенести файл", e);
        }
    }

    private scheduleRefresh() {
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => this.refreshNumbers(), 300);
    }

    refreshNumbers() {
        this.ranks = this.settings.showNumbers ? this.buildRanks() : new Map<string, NumberInfo>();
        this.decorate();
    }

    private buildRanks(): Map<string, NumberInfo> {
        const files = this.app.vault.getMarkdownFiles();
        const parentsMap = new Map<string, TFile[]>();
        const childrenMap = new Map<string, TFile[]>();
        const pins = new Map<string, number>();

        for (const f of files) {
            const found = this.parentsOf(f).filter(
                (p, i, arr) => p.path !== f.path && arr.findIndex((q) => q.path === p.path) === i
            );
            parentsMap.set(f.path, found);
            for (const p of found) {
                const list = childrenMap.get(p.path) ?? [];
                list.push(f);
                childrenMap.set(p.path, list);
            }

            const v = this.app.metadataCache.getFileCache(f)?.frontmatter?.[ORDER_KEY];
            if (typeof v === "number" && Number.isFinite(v) && v >= 1) {
                pins.set(f.path, Math.floor(v));
            }
        }

        const importance = (a: TFile, b: TFile) =>
            (childrenMap.get(b.path)?.length ?? 0) - (childrenMap.get(a.path)?.length ?? 0) ||
            a.basename.localeCompare(b.basename);

        const sortedKids = new Map<string, TFile[]>();
        for (const [parentPath, kids] of childrenMap) {
            const used = new Set<number>();
            const slot = new Map<string, number>();

            const pinned = kids
                .filter((k) => pins.has(k.path))
                .sort((a, b) => (pins.get(a.path) ?? 0) - (pins.get(b.path) ?? 0));
            for (const k of pinned) {
                let n = pins.get(k.path) ?? 1;
                while (used.has(n)) n++;
                used.add(n);
                slot.set(k.path, n);
            }

            let n = 1;
            for (const k of kids.filter((k) => !pins.has(k.path)).sort(importance)) {
                while (used.has(n)) n++;
                used.add(n);
                slot.set(k.path, n);
                n++;
            }

            sortedKids.set(
                parentPath,
                [...kids].sort((a, b) => (slot.get(a.path) ?? 0) - (slot.get(b.path) ?? 0))
            );
        }

        const roots = files
            .filter((f) => {
                if ((parentsMap.get(f.path) ?? []).length > 0) return false;
                const folderName = f.parent?.name ?? "";
                return childrenMap.has(f.path) || (folderName !== "" && folderName === f.basename);
            })
            .sort((a, b) => a.path.localeCompare(b.path));

        const out = new Map<string, NumberInfo>();
        let global = 0;
        for (const root of roots) {
            let n = 0;
            const seen = new Set<string>();
            const stack: TFile[] = [root];

            while (stack.length) {
                const f = stack.pop();
                if (!f || seen.has(f.path)) continue;
                seen.add(f.path);

                out.set(f.path, {
                    label: fmt(n++),
                    order: global++,
                    parents: (parentsMap.get(f.path) ?? []).map((p) => p.basename),
                    root: f.path === root.path,
                });

                const kids = (sortedKids.get(f.path) ?? []).filter(
                    (k) => parentsMap.get(k.path)?.[0]?.path === f.path
                );
                for (let i = kids.length - 1; i >= 0; i--) {
                    const k = kids[i];
                    if (k) stack.push(k);
                }
            }
        }
        return out;
    }

    private decorate() {
        const on = this.settings.showNumbers;

        for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
            leaf.view.containerEl
                .querySelectorAll<HTMLElement>(".nav-folder-children")
                .forEach((box) => {
                    box.classList.toggle("inherit-sorted", on);
                    const ranked: { el: HTMLElement; order: number }[] = [];

                    for (const el of Array.from(box.children)) {
                        if (!(el instanceof HTMLElement) || !el.classList.contains("tree-item")) continue;

                        if (el.classList.contains("nav-folder")) {
                            if (on) el.style.order = "-1";
                            else el.style.removeProperty("order");
                            continue;
                        }

                        const title = el.querySelector<HTMLElement>(":scope > .nav-file-title");
                        if (!title) continue;

                        const info = on ? this.ranks.get(title.dataset.path ?? "") : undefined;
                        let span = title.querySelector<HTMLElement>(":scope > .inherit-number");

                        if (!info) {
                            span?.remove();
                            if (on) el.style.order = "100000";
                            else el.style.removeProperty("order");
                            continue;
                        }

                        const tip = info.root
                            ? "Корневой файл"
                            : (info.parents.length > 1 ? "Родители: " : "Родитель: ") +
                            info.parents.join(", ");
                        if (!span) {
                            span = document.createElement("span");
                            span.className = "inherit-number";
                            title.insertBefore(span, title.querySelector(":scope > .nav-file-title-content"));
                        }

                        if (span.textContent !== info.label) span.textContent = info.label;
                        span.classList.toggle("is-root", info.root);
                        if (span.getAttribute("aria-label") !== tip) span.setAttribute("aria-label", tip);

                        ranked.push({ el, order: info.order });
                    }

                    ranked.sort((a, b) => a.order - b.order);
                    ranked.forEach((r, i) => (r.el.style.order = String(i)));
                });
        }
    }

    private observeExplorer() {
        this.observer?.disconnect();
        this.observer = new MutationObserver(() => {
            window.clearTimeout(this.decorTimer);
            this.decorTimer = window.setTimeout(() => this.decorate(), 50);
        });
        for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
            this.observer.observe(leaf.view.containerEl, { childList: true, subtree: true });
        }
    }

    private rawParents(f: TFile): string[] {
        const v = this.app.metadataCache.getFileCache(f)?.frontmatter?.[PARENT_KEY];
        if (typeof v === "string") return [v];
        if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
        return [];
    }

    private parentsOf(f: TFile): TFile[] {
        const links = this.app.metadataCache.getFileCache(f)?.frontmatterLinks ?? [];
        const out: TFile[] = [];
        for (const l of links) {
            if (l.key !== PARENT_KEY && !l.key.startsWith(PARENT_KEY + ".")) continue;
            const t = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), f.path);
            if (t) out.push(t);
        }
        return out;
    }

    private wouldCycle(child: TFile, newParent: TFile): boolean {
        const seen = new Set<string>();
        const stack: TFile[] = [newParent];
        while (stack.length) {
            const cur = stack.pop()!;
            if (cur.path === child.path) return true;
            if (seen.has(cur.path)) continue;
            seen.add(cur.path);
            stack.push(...this.parentsOf(cur));
        }
        return false;
    }
}

class InheritSettingTab extends PluginSettingTab {
    plugin: InheritPlugin;

    constructor(app: App, plugin: InheritPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Создавать файл в папке исходной заметки")
            .setDesc(
                "При клике по @#[[Имя]] новый файл появится в папке родителя, " +
                "при клике по @[[Имя]] — в папке дочерней заметки. " +
                "Если выключено, папку выбирает сам Obsidian (настройка «Расположение новых заметок»)."
            )
            .addToggle((t) =>
                t.setValue(this.plugin.settings.sameFolder).onChange(async (v) => {
                    this.plugin.settings.sameFolder = v;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName("Номера и сортировка в проводнике")
            .setDesc(
                "Рядом с файлом показывается номер, и файлы внутри папки идут в порядке номеров. " +
                "Нумерация сквозная по порядку обхода дерева: корень 00, дальше 01, 02, 03... " +
                "Среди детей одного родителя выше тот, у кого больше детей. " +
                "Закрепить место среди соседей можно свойством order: 1. " +
                "Файл с несколькими родителями стоит в дереве под первым из них. " +
                "Меняется только внешний вид: файлы и их имена не трогаются, папки остаются сверху."
            )
            .addToggle((t) =>
                t.setValue(this.plugin.settings.showNumbers).onChange(async (v) => {
                    this.plugin.settings.showNumbers = v;
                    await this.plugin.saveSettings();
                    this.plugin.refreshNumbers();
                })
            );
    }
}