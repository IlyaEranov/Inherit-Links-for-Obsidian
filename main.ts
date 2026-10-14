import { Plugin, TFile } from "obsidian"

const PARENT_PROPERTY = "parent"
const INHERIT_RE = /(?<![\p{L}\p{N}_])@\[\[([^\[\]|#^]+)(?:[#^|][^\[\]]*)?\]\]/u;

export default class InheritPlugin extends Plugin{
    private timers = new Map<string, number>()

    async onload(){
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if(!(file instanceof TFile) || file.extension !== "md") return
                window.clearTimeout(this.timers.get(file.path))
                this.timers.set(file.path, window.setTimeout(() => this.syncParent(file), 1000))
            })
        )
    }

    onunload(): void {
        this.timers.forEach((t) => window.clearTimeout(t))
    }

    private async syncParent(file: TFile){
        const raw = await this.app.vault.cachedRead(file)
        const body = raw
            .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/`[^`\n]*`/g, "")
        
        const m = INHERIT_RE.exec(body)
        if(!m) return

        const name = m[1]?.trim()
        if(!name) return

        const parent = `[[${name}]]`
        const cached = this.app.metadataCache.getFileCache(file)?.frontmatter
        if(cached?.[PARENT_PROPERTY] === parent) return

        await this.app.fileManager.processFrontMatter(file, (fm) => {
            if(fm[PARENT_PROPERTY] !== parent) fm[PARENT_PROPERTY] = parent
        })
    }
}
