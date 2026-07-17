"use strict";
const { Menu, Setting } = require("obsidian");
const { capturePointer, releasePointer, tuning } = require("./toolkit.js");
// Reusable name-pill list + editor (click-to-select + drag-reorder pills, Add button, per-item editor). cfg: { items, makeItem, labelOf, addText, pickName, pickDesc, emptyText, renderBody, onMutate, save, onAdd?, onDelete? }.
class ListEditor {
    constructor(tab, cfg) {
        this.tab = tab;
        this.cfg = cfg;
        this.editingId = null;
        this.gridEl = null;
        this.editorEl = null;
        this.pillEls = new Map();
        // Pointer-drag reorder state.
        this.reorderPill = null;
        this.reorderPointerId = null;
        this.reorderStartX = 0;
        this.reorderStartY = 0;
        this.reorderMoved = false;
        this.suppressNextClick = false;
    }
    // Build the Add button, the pill grid, and the editor host into containerEl.
    mount(containerEl) {
        new Setting(containerEl)
            .setName(this.cfg.pickName)
            .setDesc(this.cfg.pickDesc)
            .addButton((b) => b
            .setButtonText(this.cfg.addText)
            .setCta()
            .onClick(async () => {
            const item = this.cfg.makeItem();
            this.cfg.items().push(item);
            if (this.cfg.onAdd)
                this.cfg.onAdd(item);
            this.editingId = item.id;
            await this.cfg.save();
            this.cfg.onMutate();
            this.rebuildPills();
            this.renderEditor();
        }));
        this.gridEl = containerEl.createDiv({ cls: "cc-pill-grid" });
        this.editorEl = containerEl.createDiv();
        this.rebuildPills();
        this.renderEditor();
    }
    rebuildPills() {
        const grid = this.gridEl;
        if (!grid)
            return;
        grid.empty();
        this.pillEls.clear();
        const items = this.cfg.items();
        if (this.editingId && !items.some((c) => c.id === this.editingId))
            this.editingId = null;
        if (!this.editingId && items.length > 0)
            this.editingId = items[0].id;
        for (const it of items) {
            const pill = this.createPill(grid, this.cfg.labelOf(it) || "(unnamed)", it.id === this.editingId, () => this.select(it.id));
            this.makeReorderable(pill, it.id);
            this.pillEls.set(it.id, pill);
        }
    }
    // Create a pill button; a click that concluded a reorder drag is swallowed.
    createPill(grid, text, active, onClick) {
        const pill = grid.createEl("button", { cls: "cc-pill", text });
        if (active)
            pill.classList.add("cc-pill-active");
        pill.addEventListener("click", () => {
            if (this.suppressNextClick) {
                this.suppressNextClick = false;
                return;
            }
            void onClick(pill);
        });
        return pill;
    }
    // Make a pill a drag handle that reorders the list: it slides through the grid in the DOM as it's dragged (live layout IS the preview); on drop the DOM order is read back.
    makeReorderable(pill, id) {
        pill.dataset.ccId = id;
        pill.addEventListener("pointerdown", (e) => this.onReorderDown(pill, e));
        pill.addEventListener("pointermove", (e) => this.onReorderMove(e));
        pill.addEventListener("pointerup", (e) => this.onReorderUp(e));
        pill.addEventListener("pointercancel", (e) => this.onReorderUp(e));
        // Right-click a pill to delete its item — the only delete path.
        pill.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const menu = new Menu();
            menu.addItem((i) => i.setTitle("Delete").setIcon("trash").onClick(() => { void this.deleteItem(id); }));
            menu.showAtMouseEvent(e);
        });
    }
    onReorderDown(pill, e) {
        if (e.button !== 0)
            return;
        this.reorderPill = pill;
        this.reorderPointerId = e.pointerId;
        this.reorderStartX = e.clientX;
        this.reorderStartY = e.clientY;
        this.reorderMoved = false;
        capturePointer(pill, e.pointerId);
    }
    onReorderMove(e) {
        if (this.reorderPointerId === null || e.pointerId !== this.reorderPointerId)
            return;
        if (!this.reorderMoved) {
            if (Math.hypot(e.clientX - this.reorderStartX, e.clientY - this.reorderStartY) < tuning().dragThreshold)
                return;
            this.reorderMoved = true;
            this.reorderPill.classList.add("cc-pill-dragging");
        }
        // Find the pill under the pointer (hiding the dragged pill from the hit test), then move the dragged pill to its near/far side — the grid reflows.
        this.reorderPill.classList.add("cc-no-hit");
        const under = this.gridEl.doc.elementFromPoint(e.clientX, e.clientY);
        this.reorderPill.classList.remove("cc-no-hit");
        const target = under ? under.closest(".cc-pill") : null;
        if (!target || target === this.reorderPill || !this.gridEl.contains(target))
            return;
        const rect = target.getBoundingClientRect();
        if (e.clientX > rect.left + rect.width / 2)
            target.after(this.reorderPill);
        else
            target.before(this.reorderPill);
    }
    async onReorderUp(e) {
        if (this.reorderPointerId === null || e.pointerId !== this.reorderPointerId)
            return;
        releasePointer(this.reorderPill, e.pointerId);
        this.reorderPill.classList.remove("cc-pill-dragging");
        const moved = this.reorderMoved;
        this.reorderPill = null;
        this.reorderPointerId = null;
        this.reorderMoved = false;
        if (!moved)
            return;
        // Swallow the click this pointer-up also fires on the pill.
        this.suppressNextClick = true;
        // Mirror the pills' new DOM order into the list.
        const order = [...this.gridEl.querySelectorAll(".cc-pill")].map((el) => el.dataset.ccId);
        this.cfg.items().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        await this.cfg.save();
        this.cfg.onMutate();
    }
    select(id) {
        this.editingId = id;
        this.pillEls.forEach((pill, cid) => pill.classList.toggle("cc-pill-active", cid === id));
        this.renderEditor();
    }
    // Update one pill's label in place (a rename, without rebuilding the grid).
    refreshPillLabel(id, text) {
        const pill = this.pillEls.get(id);
        if (pill)
            pill.setText(text);
    }
    renderEditor() {
        const host = this.editorEl;
        if (!host)
            return;
        host.empty();
        const editing = this.cfg.items().find((c) => c.id === this.editingId);
        if (editing)
            this.cfg.renderBody(host, editing, this);
        else
            host.createDiv({ cls: "cc-empty", text: this.cfg.emptyText });
    }
    // Remove an item: drop it, let the owner patch up dependent state, persist, rebuild.
    async deleteItem(id) {
        const items = this.cfg.items();
        const i = items.findIndex((c) => c.id === id);
        if (i < 0)
            return;
        items.splice(i, 1);
        if (this.cfg.onDelete)
            this.cfg.onDelete(id);
        this.editingId = null;
        await this.cfg.save();
        this.cfg.onMutate();
        this.rebuildPills();
        this.renderEditor();
    }
}
module.exports = { ListEditor };
