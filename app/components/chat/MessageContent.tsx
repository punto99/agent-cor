"use client";

import ReactMarkdown from "react-markdown";
import { ExternalLink, Link as LinkIcon } from "lucide-react";

// Tipos
type MessagePart = {
  type: "text" | "file";
  text?: string;
  url?: string;
  mediaType?: string;
  state?: string;
};

type ReasoningDetail = {
  type: "text";
  text: string;
};

type Message = {
  key: string;
  role: "user" | "assistant";
  content: string | MessagePart[];
  _creationTime: number;
  agentName?: string;
  status?: string;
  reasoning?: string;
  reasoningDetails?: ReasoningDetail[];
};

function isImageFilePart(part: MessagePart, hasWordContent: boolean) {
  if (part.type !== "file" || !part.url) return false;
  if (hasWordContent && part.mediaType?.startsWith("image/")) return false;
  return part.mediaType?.startsWith("image/") ?? false;
}

interface MessageContentProps {
  message: Message;
  showLinkPreviews?: boolean;
}

/**
 * Componente para renderizar el contenido de un mensaje
 * Soporta texto, imágenes, PDFs, audio y documentos Word
 */
export function MessageContent({
  message,
  showLinkPreviews = false,
}: MessageContentProps) {
  // Manejar contenido vacío
  if (!message.content) {
    return <div className="text-gray-400 italic">Sin contenido</div>;
  }

  // Si el contenido es un array (mensaje con partes)
  if (Array.isArray(message.content)) {
    // Detectar si el mensaje contiene contenido de Word
    const hasWordContent = message.content.some(
      (part) =>
        part.type === "text" &&
        part.text &&
        part.text.includes('--- Contenido extraído del documento "') &&
        part.text.includes("--- Fin del documento ---"),
    );

    const imageParts = message.content.filter((part) =>
      isImageFilePart(part, hasWordContent),
    );

    return (
      <div className="space-y-2">
        {imageParts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {imageParts.map((part, idx) => (
              <FilePart
                key={`${part.url}-${idx}`}
                url={part.url!}
                mediaType={part.mediaType}
                hasWordContent={hasWordContent}
              />
            ))}
          </div>
        )}

        {message.content.map((part, idx) => {
          if (isImageFilePart(part, hasWordContent)) {
            return null;
          }
          if (part.type === "text" && part.text) {
            return (
              <TextPart
                key={idx}
                text={part.text}
                role={message.role}
                hasWordContent={hasWordContent}
                showLinkPreviews={showLinkPreviews}
              />
            );
          }
          if (part.type === "file" && part.url) {
            return (
              <FilePart
                key={idx}
                url={part.url}
                mediaType={part.mediaType}
                hasWordContent={hasWordContent}
              />
            );
          }
          return null;
        })}
      </div>
    );
  }

  // Si es un string (mensaje simple)
  const textContent =
    typeof message.content === "string" ? message.content : "";

  // Renderizar markdown para todos los mensajes (usuario y asistente)
  return (
    <TextWithOptionalLinkPreviews
      text={textContent}
      role={message.role}
      showLinkPreviews={showLinkPreviews}
    />
  );
}

// Subcomponente para texto con markdown
interface TextPartProps {
  text: string;
  role: "user" | "assistant";
  hasWordContent: boolean;
  showLinkPreviews: boolean;
}

function TextPart({
  text,
  role,
  hasWordContent,
  showLinkPreviews,
}: TextPartProps) {
  // Detectar si el texto contiene contenido extraído de Word
  const wordMarkerStart = '--- Contenido extraído del documento "';
  const wordMarkerEnd = "--- Fin del documento ---";
  const partHasWordContent =
    text.includes(wordMarkerStart) && text.includes(wordMarkerEnd);

  // Si es contenido de Word en mensaje de usuario, mostrar icono
  if (partHasWordContent && role === "user") {
    const parts = text.split(wordMarkerStart);
    const userText = parts[0].trim();
    const match = text.match(
      /--- Contenido extraído del documento "(.+?)" ---/,
    );
    const filename = match ? match[1] : "Documento Word";
    const isDocx = filename.toLowerCase().endsWith(".docx");

    return (
      <div className="space-y-2">
        {userText && (
          <TextWithOptionalLinkPreviews
            text={userText}
            role={role}
            showLinkPreviews={showLinkPreviews}
          />
        )}
        <div className="bg-slate-100 rounded-lg p-2 flex items-center gap-2 border border-slate-200 hover:bg-slate-200 hover:border-slate-300 transition-colors cursor-pointer">
          <span className="text-slate-500">📝</span>
          <span className="text-xs text-slate-600 truncate">
            {isDocx ? "Documento DOCX" : "Documento DOC"}
          </span>
        </div>
      </div>
    );
  }

  if (role === "assistant") {
    return <MarkdownRenderer content={text} role={role} />;
  }

  // Renderizar markdown también para mensajes del usuario
  return (
    <TextWithOptionalLinkPreviews
      text={text}
      role={role}
      showLinkPreviews={showLinkPreviews}
    />
  );
}

type LinkPreview = {
  url: string;
  label: string;
};

const URL_REGEX = /https?:\/\/[^\s<>"'`)\]]+/gi;
const TRAILING_URL_PUNCTUATION = /[.,;:!?]+$/;

function extractLinkPreviews(text: string): LinkPreview[] {
  const matches = text.match(URL_REGEX) || [];
  const urls = Array.from(
    new Set(matches.map((url) => url.replace(TRAILING_URL_PUNCTUATION, ""))),
  );

  return urls
    .map((url) => {
      try {
        const parsed = new URL(url);
        return {
          url,
          label: getLinkProviderLabel(parsed.hostname),
        };
      } catch {
        return null;
      }
    })
    .filter((preview): preview is LinkPreview => preview !== null);
}

function getLinkProviderLabel(hostname: string): string {
  const normalized = hostname.toLowerCase();
  if (normalized.includes("box.com")) return "Box";
  if (normalized.includes("drive.google.com")) return "Google Drive";
  if (normalized.includes("dropbox.com")) return "Dropbox";
  if (normalized.includes("figma.com")) return "Figma";
  if (normalized.includes("canva.com")) return "Canva";
  return hostname.replace(/^www\./, "");
}

function formatPreviewUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const compactPath =
      parsed.pathname.length > 28
        ? `${parsed.pathname.slice(0, 28)}...`
        : parsed.pathname;
    return `${parsed.hostname.replace(/^www\./, "")}${compactPath}`;
  } catch {
    return url.length > 42 ? `${url.slice(0, 42)}...` : url;
  }
}

function autolinkBareUrls(text: string): string {
  return text.replace(URL_REGEX, (rawUrl, offset, fullText) => {
    const url = rawUrl.replace(TRAILING_URL_PUNCTUATION, "");
    const trailing = rawUrl.slice(url.length);
    const previousChars = fullText.slice(Math.max(0, offset - 2), offset);

    // Avoid rewriting markdown links/images or markdown autolinks.
    if (previousChars === "](" || previousChars === "!(") {
      return rawUrl;
    }
    if (fullText[offset - 1] === "<") {
      return rawUrl;
    }

    try {
      new URL(url);
      return `[${url}](${url})${trailing}`;
    } catch {
      return rawUrl;
    }
  });
}

function TextWithOptionalLinkPreviews({
  text,
  role,
  showLinkPreviews,
}: {
  text: string;
  role: "user" | "assistant";
  showLinkPreviews: boolean;
}) {
  const previews =
    showLinkPreviews && role === "user" ? extractLinkPreviews(text) : [];
  const markdownContent =
    showLinkPreviews && role === "user" ? autolinkBareUrls(text) : text;

  return (
    <div className="space-y-3">
      <MarkdownRenderer content={markdownContent} role={role} />
      {previews.length > 0 && <LinkPreviewList previews={previews} />}
    </div>
  );
}

function LinkPreviewList({ previews }: { previews: LinkPreview[] }) {
  return (
    <div className="rounded-md border border-primary-foreground/25 bg-primary-foreground/10 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary-foreground/85">
        <LinkIcon className="size-3.5" aria-hidden="true" />
        <span>Referencias compartidas</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {previews.map((preview) => (
          <a
            key={preview.url}
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            title={preview.url}
            className="group flex min-w-0 items-center gap-2 rounded-md border border-primary-foreground/20 bg-primary-foreground/10 px-2.5 py-2 text-primary-foreground transition-colors hover:bg-primary-foreground/20"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-foreground/20">
              <LinkIcon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold">
                {preview.label}
              </span>
              <span className="block truncate text-[11px] text-primary-foreground/75">
                {formatPreviewUrl(preview.url)}
              </span>
            </span>
            <ExternalLink
              className="size-3.5 shrink-0 opacity-70 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          </a>
        ))}
      </div>
    </div>
  );
}

// Subcomponente para archivos
interface FilePartProps {
  url: string;
  mediaType?: string;
  hasWordContent: boolean;
}

function FilePart({ url, mediaType, hasWordContent }: FilePartProps) {
  const filename = url.split("/").pop() || "";
  const isWordByFilename =
    filename.toLowerCase().endsWith(".docx") ||
    filename.toLowerCase().endsWith(".doc");
  const isWordByMediaType =
    mediaType?.includes("word") || mediaType?.includes("document");

  // No mostrar archivos Word individualmente
  if (isWordByFilename || isWordByMediaType) {
    return null;
  }

  // No mostrar imágenes si son del Word
  if (hasWordContent && mediaType?.startsWith("image/")) {
    return null;
  }

  // PDF
  if (mediaType === "application/pdf") {
    return (
      <div className="bg-slate-100 rounded-lg p-2 flex items-center gap-2 border border-slate-200 hover:bg-slate-200 hover:border-slate-300 transition-colors cursor-pointer">
        <span className="text-slate-500">📄</span>
        <span className="text-xs text-slate-600 truncate">Archivo PDF</span>
      </div>
    );
  }

  // Audio
  if (mediaType === "audio/mpeg") {
    return (
      <div className="bg-slate-100 rounded-lg p-2 flex items-center gap-2 border border-slate-200 hover:bg-slate-200 hover:border-slate-300 transition-colors cursor-pointer">
        <span className="text-slate-500">🎧</span>
        <span className="text-xs text-slate-600 truncate">
          Archivo {mediaType || "audio"}
        </span>
      </div>
    );
  }

  // Imagen
  return (
    <img
      src={url}
      alt="Imagen adjunta"
      className="h-28 w-28 rounded-lg border border-gray-300 object-cover"
    />
  );
}

// Componente reutilizable para renderizar Markdown
interface MarkdownRendererProps {
  content: string;
  role?: "user" | "assistant";
}

function MarkdownRenderer({
  content,
  role = "assistant",
}: MarkdownRendererProps) {
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-2">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-bold">{children}</strong>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-4 mb-2">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-4 mb-2">{children}</ol>
          ),
          li: ({ children }) => <li className="mb-1">{children}</li>,
          code: ({ children }) => (
            <code
              className={`px-1.5 py-0.5 rounded text-sm font-mono ${
                role === "user"
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-muted text-foreground"
              }`}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="bg-muted text-foreground p-2 rounded overflow-x-auto mb-2 text-sm">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className={`font-medium underline decoration-2 underline-offset-2 transition-colors ${
                role === "user"
                  ? "text-primary-foreground decoration-primary-foreground/85 hover:text-primary-foreground/85"
                  : "text-primary decoration-primary/70 hover:text-primary/80"
              }`}
              target={href?.startsWith("/") ? "_self" : "_blank"}
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export { MarkdownRenderer };
export type { Message, MessagePart, ReasoningDetail };
