"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps, type Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { DISMISS_MENTION, nextMentionSession, filterMentionPeople, mentionQuery, type MentionSession, type MentionPerson } from "./mentions";

export function MentionLabel({ name, onRemove }: { name: string; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const close = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("scroll", dismiss, true); window.addEventListener("resize", dismiss); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss); window.removeEventListener("keydown", escape); };
  }, [open]);
  const rect = open ? anchor.current?.getBoundingClientRect() : null;
  return <><span ref={anchor} tabIndex={0} role="button" aria-label={`Mención a ${name}`} aria-expanded={open} onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(value => !value); } }} onMouseEnter={() => { cancelClose(); setOpen(true); }} onMouseLeave={close} onFocus={() => { cancelClose(); setOpen(true); }} onBlur={close} className="inline rounded bg-primary/10 px-1 py-0.5 font-medium text-primary cursor-pointer">@{name}</span>
    {open && rect && createPortal(<div role="dialog" aria-label={`Persona mencionada: ${name}`} onMouseEnter={cancelClose} onMouseLeave={close} onFocus={cancelClose} onBlur={close} style={{ position: "fixed", zIndex: 150, left: Math.max(8, Math.min(rect.left, window.innerWidth - 256)), top: rect.bottom + 8 > window.innerHeight - 100 ? Math.max(8, rect.top - 100) : rect.bottom + 8 }} className="w-60 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <p className="break-words text-sm font-semibold">{name}</p>
      {onRemove && <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(false); onRemove(); }} className="mt-2 rounded px-2 py-1 text-xs text-destructive hover:bg-muted">Quitar mención</button>}
    </div>, document.body)}
  </>;
}
function MentionView({ node, editor, getPos }: NodeViewProps) {
  return <NodeViewWrapper as="span" contentEditable={false}><MentionLabel name={node.attrs.label} onRemove={editor.isEditable ? () => {
    if (!editor.isEditable) return;
    const pos = getPos(); if (typeof pos === "number") editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
  } : undefined} /></NodeViewWrapper>;
}
export const Mention = Node.create({
  name: "mention", group: "inline", inline: true, atom: true, selectable: true,
  addAttributes: () => ({ userId: { default: "" }, label: { default: "" } }),
  // Pasted HTML cannot forge selected mentions.
  parseHTML: () => [],
  renderText: ({ node }) => `@${node.attrs.label}`,
  renderHTML: ({ node }) => ["span", { "data-mention": node.attrs.userId }, `@${node.attrs.label}`],
  addNodeView: () => ReactNodeViewRenderer(MentionView),
});

export function MentionSuggestions({ editor, people }: { editor: Editor; people: MentionPerson[] }) {
  const [revision, update] = useState(0);
  const session = useRef<MentionSession>(null);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => {
    const refresh = () => update(value => value + 1);
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      session.current = nextMentionSession(session.current, transaction);
      refresh();
    };
    const onBlur = () => { session.current = null; refresh(); };
    editor.on("transaction", onTransaction); editor.on("focus", refresh); editor.on("blur", onBlur);
    window.addEventListener("scroll", refresh, true); window.addEventListener("resize", refresh);
    return () => { editor.off("transaction", onTransaction); editor.off("focus", refresh); editor.off("blur", onBlur); window.removeEventListener("scroll", refresh, true); window.removeEventListener("resize", refresh); };
  }, [editor]);
  const { selection } = editor.state;
  const query = session.current && selection.empty && editor.isFocused && editor.isEditable
    ? mentionQuery(selection.$from.parent.textBetween(0, selection.$from.parentOffset, "\n", "\ufffc")) : null;
  const key = query ? `${selection.from}:${query.query}` : "";
  const options = query ? filterMentionPeople(people, query.query) : [];
  const visible = Boolean(query && options.length);
  useEffect(() => { setActive(0); }, [key]);
  const choose = (person: MentionPerson) => {
    if (!query) return;
    editor.chain().focus().insertContentAt({ from: selection.from - query.length, to: selection.from }, [{ type: "mention", attrs: { userId: person.id, label: person.name } }, { type: "text", text: " " }]).run();
  };
  useLayoutEffect(() => {
    if (!visible) return;
    const rect = editor.view.coordsAtPos(selection.from);
    const height = Math.min(options.length * 40 + 40, 256);
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), top: rect.bottom + 6 + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6 });
  }, [revision, visible, selection.from, options.length, editor]);
  useEffect(() => {
    if (!query) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ([" ", "Backspace", "Delete", "Escape"].includes(event.key)) {
        editor.view.dispatch(editor.state.tr.setMeta(DISMISS_MENTION, true));
        // Space and deletion must still reach the editor normally.
        if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); }
        return;
      }
      if (!visible) return;
      if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Enter") choose(options[Math.min(active, options.length - 1)]);
      else setActive(index => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    };
    editor.view.dom.addEventListener("keydown", handleKey, true);
    return () => editor.view.dom.removeEventListener("keydown", handleKey, true);
  });
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  if (!visible) return null;
  return createPortal(<div style={{ position: "fixed", ...position, zIndex: 140 }} className="w-72 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl" onMouseDown={event => event.preventDefault()}>
    <p className="px-3 py-2 text-xs font-medium text-muted-foreground">Mencionar a una persona</p>
    <div ref={list} role="listbox" aria-label="Personas con acceso" className="max-h-52 overflow-y-auto p-1">
      {options.map((person, index) => <button key={person.id} type="button" role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => choose(person)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${index === active ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}><span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] text-primary">{person.name.split(/\s+/).slice(0, 2).map(p => p[0]).join("")}</span>{person.name}</button>)}
    </div>
  </div>, document.body);
}
