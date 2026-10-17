import { getLinkpath, MarkdownView, Notice, Plugin, TFile } from "obsidian"

const PARENT_TAG = "parent"
const PARENT_RE = /(?<![\p{L}\p{N}_])@\[\[([^\[\]|#^]+)(?:[#^|][^\[\]]*)?\]\]/gu
const CHILD_RE = /(?<![\p{L}\p{N}_])@#\[\[([^\[\]|#^]+)(?:[#^|][^\[\]]*)?\]\]/gu

const clearRawBody = (s: string) => s
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")

export default class InheriPlugin extends Plugin{
    private timers = new Map<string, number>()
    
    async onload(){
        this.registerEvent(
            this.app.vault.on("modify", (f) => {
                if(f instanceof TFile && f.extension === "md") this.schedule(f)
            })
        )

        this.app.workspace.onLayoutReady(() => {
            this.registerEvent(
                this.app.vault.on("create", (f) => {
                    if(f instanceof TFile && f.extension === "md") this.onCreated(f)
                })
            )
        })
    }

    onunload(): void {
        this.timers.forEach((t) => window.clearTimeout(t))
    }

    private schedule(f: TFile, delay = 1000){
        window.clearTimeout(this.timers.get(f.path))
        this.timers.set(f.path, window.setTimeout(() => this.sync(f), delay))
    }

    private async sync(f: TFile){
        const view = this.app.workspace.getActiveViewOfType(MarkdownView)
        const editing = view?.file?.path === f.path ? view : null
        const raw = editing ? editing.editor.getValue() : await this.app.vault.cachedRead(f)
        
        const body = clearRawBody(raw)
        const seen = new Set<string>()
        const wantedNames: string[] = []
        const blocked: TFile[] = []
        let nameFound = false

        const cursor = editing ? editing.editor.posToOffset(editing.editor.getCursor()) : -1
        for(const m of body.matchAll(PARENT_RE)){
            const start = m.index ?? 0
            if(cursor > start && cursor < start + m[0].length){
                this.schedule(f, 2000)
                return
            }

            const name = m[1]?.trim()
            if(!name || seen.has(name)) continue
            seen.add(name)
            nameFound = true

            const target = this.app.metadataCache.getFirstLinkpathDest(name, f.path)
            if(!target || target.extension !== "md") continue
            if(this.checkDuplicate(f, target)){
                blocked.push(target)
                continue
            }

            wantedNames.push(`[[${name}]]`)
        }

        if(!nameFound) return

        for(const b of blocked){
            new Notice(
                `"${f.basename}" cannot be a child of file "${b.basename}". You will get a loop.`
            )
        }

        if(wantedNames.length === 0) return

        const current = this.rawParents(f)
        if(current.length === wantedNames.length && current.every((e, i) => e === wantedNames[i])) return

        await this.app.fileManager.processFrontMatter(f, (fm) => fm[PARENT_TAG] = wantedNames)
    }

    private async onCreated(newFile: TFile){

        await new Promise((r) => window.setTimeout(r, 300))

        const parents: TFile[]  = []
        const cache = this.app.metadataCache

        for(const f of this.app.vault.getMarkdownFiles()){
            if(f.path === newFile.path) continue
            const links = cache.getFileCache(f)?.links
            const points = links?.some((l) => cache.getFirstLinkpathDest(getLinkpath(l.link), f.path)?.path === newFile.path)
            if(!points) continue

            const body = clearRawBody(await this.app.vault.cachedRead(f))
            
            for(const m of body.matchAll(CHILD_RE)){
                if(m[1] && cache.getFirstLinkpathDest(m[1].trim(), f.path)?.path === newFile.path){
                    if(!parents.includes(f)) parents.push(f)
                    break
                }
            }

            for(const m of body.matchAll(PARENT_RE)){
                if(m[1] && cache.getFirstLinkpathDest(m[1].trim(), f.path)?.path === newFile.path){
                    this.schedule(f, 300)
                    break
                }
            }
        }

        if(parents.length === 0) return

        await this.app.vault.process(newFile, (data) => {
            const links = parents.map((e) => `[[${e.basename}]]`)
            const missing = links.filter((e) => !data.includes(`@${e}`))
            if(missing.length === 0) return data

            if(data.trim() === ""){
                const list = links.map((e) => `  -  "${e}"`).join("\n")
                return (
                    `---\n${PARENT_TAG}:\n${list}\n---\n` +
                    links.map((e) => `@${e}`).join("\n") +
                    "\n"
                ) 
            }

            return data.replace(/\s*$/, "") + "\n" + missing.map((e) => `@${e}`).join("\n") + "\n"
        })
    }

    private rawParents(f: TFile): string[] {
        const v = this.app.metadataCache.getFileCache(f)?.frontmatter?.[PARENT_TAG]
        if(typeof v === "string") return [v]
        if(Array.isArray(v)) return v.filter((e): e is string => typeof e === "string")
        return []
    }

    private parentsOf(f: TFile): TFile[] {
        const links = this.app.metadataCache.getFileCache(f)?.frontmatterLinks ?? []
        const out: TFile[] = []
        for(const l of links){
            if(l.key !== PARENT_TAG && l.key.startsWith(PARENT_TAG + ".")) continue
            const pathLink = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), f.path)
            if(pathLink) out.push(pathLink)
        }
        return out
    }

    private checkDuplicate(child: TFile, newParent: TFile){
        const seen = new Set<string>()
        const stack: TFile[] = [newParent]
        while(stack.length){
            const current = stack.pop()!
            if(current.path === child.path) return true
            if(seen.has(current.path)) continue
            seen.add(current.path)
            stack.push(...this.parentsOf(current))
        }
        return false
    }
}
