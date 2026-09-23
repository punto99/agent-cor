"use client";
import { useEffect, useRef, useState } from "react";
import { Node, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List, ListOrdered, Paperclip, AtSign } from "lucide-react";
import { commentFileIds, serializeComment } from "./serializeComment";

const DraftFile = Node.create({
  name: "draftFile", group: "block", atom: true, selectable: true,
  addAttributes: () => ({ fileId: { default: null }, filename: { default: "" }, preview: { default: null } }),
  // Files can only enter through the local picker/paste/drop, never pasted HTML.
  parseHTML: () => [],
  renderHTML: ({ node }) => ["div", { "data-draft-file": "", class: "my-3 w-fit max-w-full break-words" }, node.attrs.preview ? ["img", { src: node.attrs.preview, alt: node.attrs.filename, class: "max-h-64 max-w-full object-contain" }] : ["span", { class: "text-primary underline" }, node.attrs.filename]],
});
const allowed = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
export function CommentEditor({ disabled, onChange, footer }: { disabled: boolean; footer?: React.ReactNode; onChange: (text: string, files: File[]) => void }) {
  const drafts = useRef(new Map<string, { file: File; preview: string | null }>());
  const input = useRef<HTMLInputElement>(null);
  const callback = useRef(onChange); callback.current = onChange;
  const [error, setError] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const addFilesRef = useRef<(files: File[]) => void>(() => {});
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({ heading: false, blockquote: false, codeBlock: false, code: false, strike: false, link: false, underline: false, horizontalRule: false }), DraftFile],
    editorProps: {
      attributes: { role: "textbox", "aria-label": "Escribir un comentario", "aria-multiline": "true", class: "min-h-20 p-3 text-sm outline-none [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_.ProseMirror-selectednode]:ring-2 [&_.ProseMirror-selectednode]:ring-primary" },
      handlePaste: (_view, event) => { const files = Array.from(event.clipboardData?.files ?? []); if (!files.length) return false; event.preventDefault(); addFilesRef.current(files); return true; },
      handleDrop: (_view, event) => { const files = Array.from(event.dataTransfer?.files ?? []); if (!files.length) return false; event.preventDefault(); addFilesRef.current(files); return true; },
    },
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON(); const ids = commentFileIds(doc);
      callback.current(serializeComment(doc, ids), ids.flatMap(id => drafts.current.get(id)?.file ?? []));
    },
    onTransaction: () => redraw(n => n + 1),
  });
  addFilesRef.current = files => {
    if (!editor || disabled) return;
    const count = commentFileIds(editor.getJSON()).length;
    if (count + files.length > 10) { setError("Podés adjuntar hasta 10 archivos por comentario."); return; }
    if (files.some(file => !allowed.has(file.type) || file.size === 0 || file.size > 20 * 1024 * 1024)) { setError("Usá imágenes, PDF o Word de hasta 20 MB por archivo."); return; }
    setError(null);
    const nodes = files.map(file => {
      const fileId = crypto.randomUUID(); const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      drafts.current.set(fileId, { file, preview });
      return { type: "draftFile", attrs: { fileId, filename: file.name, preview } };
    });
    editor.chain().focus().insertContent([...nodes, { type: "paragraph" }]).run();
  };
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => { const files = drafts.current; return () => files.forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); }); }, []);
  const actions = [
    { label: "Negrita", Icon: Bold, active: editor?.isActive("bold"), run: () => editor?.chain().focus().toggleBold().run() },
    { label: "Cursiva", Icon: Italic, active: editor?.isActive("italic"), run: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Lista", Icon: List, active: editor?.isActive("bulletList"), run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: "Lista numerada", Icon: ListOrdered, active: editor?.isActive("orderedList"), run: () => editor?.chain().focus().toggleOrderedList().run() },

  ];
  return <div className="overflow-hidden rounded-lg border border-border/80 bg-background transition-shadow focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
    <div role="toolbar" aria-label="Formato del comentario" className="flex flex-wrap gap-0.5 border-b border-border/60 bg-muted/30 p-1">{actions.map(({ label, Icon, active, run }) => <button key={label} type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled || !editor} onClick={run} className={`rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 ${active ? "bg-muted text-primary" : ""}`}><Icon className="h-4 w-4" /></button>)}
      <button type="button" title="Adjuntar archivo" aria-label="Adjuntar archivo" disabled={disabled || !editor} onClick={() => input.current?.click()} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><Paperclip className="h-4 w-4" /></button>
      <input ref={input} type="file" multiple disabled={disabled} accept={Array.from(allowed).join(",")} className="hidden" onChange={event => { addFilesRef.current(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <button type="button" title="Insertar @" aria-label="Insertar @" disabled={disabled || !editor} onClick={() => editor?.chain().focus().insertContent("@").run()} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"><AtSign className="h-4 w-4" /></button>
    </div>
    <div className="relative">
      {editor?.isEmpty && <span data-comment-placeholder aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-sm text-muted-foreground">Escribí un comentario…</span>}
      <EditorContent editor={editor} />
    </div>
    {footer ?? <p className="px-3 pb-2 text-[11px] text-muted-foreground">Los archivos se suben al publicar.</p>}
    {error && <p role="alert" className="px-3 pb-2 text-xs text-destructive">{error}</p>}
  </div>;
}
