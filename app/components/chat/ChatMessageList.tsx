"use client";

import { MessageContent, Message } from "./MessageContent";
import { clientConfig } from "@/config/tenant.config";

interface ChatMessageListProps {
  messages: Message[];
  isAgentThinking: boolean;
  currentThreadId: string | null;
  isCreatingThread: boolean;
  showUserLinkPreviews?: boolean;
  onRetryMessage?: (id: string) => void;
  onDismissMessage?: (id: string) => void;
}

/**
 * Lista de mensajes del chat con indicador de "pensando"
 */
export function ChatMessageList({
  messages,
  isAgentThinking,
  currentThreadId,
  isCreatingThread,
  showUserLinkPreviews = false,
  onRetryMessage,
  onDismissMessage,
}: ChatMessageListProps) {
  return (
    <>
      {isCreatingThread && (
        <div className="text-center text-muted-foreground">
          Iniciando conversación...
        </div>
      )}

      {!currentThreadId && !isCreatingThread && (
        <div className="text-center text-muted-foreground mt-8">
          <p className="text-lg mb-2">¡Bienvenido! 👋</p>
          <p className="text-sm mb-4">
            Para comenzar, haz clic en "Nueva Conversación" para iniciar una
            conversación.
          </p>
        </div>
      )}

      {messages.length === 0 && currentThreadId && !isCreatingThread && (
        <div className="text-center text-muted-foreground mt-8">
          <p className="text-lg mb-2">¡Hola! Soy tu asistente de Brief 👋</p>
          <p className="text-sm">
            Estoy aquí para ayudarte a recopilar toda la información necesaria
            para tu proyecto.
          </p>
          <p className="text-sm mt-2">
            Cuéntame sobre tu requerimiento y juntos completaremos el brief.
          </p>
        </div>
      )}

      {messages.map((message) => (
        <ChatMessage
          key={message.key}
          message={message}
          showUserLinkPreviews={showUserLinkPreviews}
          onRetryMessage={onRetryMessage}
          onDismissMessage={onDismissMessage}
        />
      ))}

      {/* Same keyed component throughout upload, confirmation and model startup. */}
      {isAgentThinking && <ThinkingIndicator key="assistant-waiting" />}
    </>
  );
}

/**
 * Componente para un mensaje individual
 */
function ChatMessage({
  message,
  showUserLinkPreviews,
  onRetryMessage,
  onDismissMessage,
}: {
  message: Message;
  showUserLinkPreviews: boolean;
  onRetryMessage?: (id: string) => void;
  onDismissMessage?: (id: string) => void;
}) {
  const localImages = message.localAttachments?.filter(file => file.previewUrl) ?? [];
  const isWord = (file: { name: string; mimeType: string }) => /\.docx?$/i.test(file.name) || file.mimeType.includes("word");
  const localDocuments = message.localAttachments?.filter(file => !file.previewUrl && !isWord(file)) ?? [];
  const localWordDocuments = message.localAttachments?.filter(file => !file.previewUrl && isWord(file)) ?? [];
  return (
    <div
      className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`min-w-0 max-w-[92%] break-words rounded-lg p-3 md:max-w-[80%] md:p-4 ${
          message.role === "user"
            ? "bg-primary text-primary-foreground"
            : "bg-card text-card-foreground shadow-sm border border-border"
        }`}
      >
        {message.role === "assistant" && message.agentName && (
          <div className="text-xs font-semibold mb-1 text-primary">
            {message.agentName}
          </div>
        )}

        {/* Mostrar razonamiento si existe */}
        {message.role === "assistant" &&
          (message.reasoning ||
            (message.reasoningDetails &&
              message.reasoningDetails.length > 0)) && (
            <div className="mb-3 p-3 bg-indigo-50/80 border border-indigo-200/50 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-indigo-600 text-xs font-medium">
                  💭 Razonamiento
                </span>
              </div>
              <div className="text-xs text-indigo-700/80 italic leading-relaxed">
                {message.reasoning ||
                  message.reasoningDetails?.map((d) => d.text).join("\n")}
              </div>
            </div>
          )}

        {message.localSendId ? (
          <div className="space-y-2">
            {localImages.length > 0 || localDocuments.length > 0 ? (
              <div className="space-y-2">
                {localImages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {localImages.map((file, index) => (
                      <div key={index} className="relative h-28 w-28 shrink-0">
                        <img src={file.previewUrl} alt={file.name}
                          className="h-28 w-28 rounded-lg border border-primary-foreground/25 object-cover" />
                        {file.isUploading && (
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                            <span className="rounded-full bg-black/20 p-1 text-white"><AttachmentUploadIndicator /></span>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {localDocuments.length > 0 && <LocalDocumentAttachments files={localDocuments} />}
              </div>
            ) : null}
            {message.content && <MessageContent message={message} showLinkPreviews={showUserLinkPreviews} />}
            {localWordDocuments.length > 0 && <LocalDocumentAttachments files={localWordDocuments} />}
            {message.sendFailed && (
              <div role="alert" className="flex flex-wrap items-center gap-3 text-xs">
                <span>No se pudo enviar el mensaje.</span>
                <button type="button" className="cursor-pointer underline" onClick={() => onRetryMessage?.(message.localSendId!)}>Reintentar</button>
                <button type="button" className="cursor-pointer underline" onClick={() => onDismissMessage?.(message.localSendId!)}>Quitar</button>
              </div>
            )}
          </div>
        ) : (
          <MessageContent
            message={message}
            showLinkPreviews={showUserLinkPreviews && message.role === "user"}
          />
        )}

        {message.status === "streaming" && (
          <div className="mt-2 flex items-center space-x-1">
            <div className="w-2 h-2 bg-current rounded-full animate-bounce"></div>
            <div
              className="w-2 h-2 bg-current rounded-full animate-bounce"
              style={{ animationDelay: "0.1s" }}
            ></div>
            <div
              className="w-2 h-2 bg-current rounded-full animate-bounce"
              style={{ animationDelay: "0.2s" }}
            ></div>
          </div>
        )}
      </div>
    </div>
  );
}

function LocalDocumentAttachments({ files }: { files: NonNullable<Message["localAttachments"]> }) {
  return <div className="space-y-2">{files.map((file, index) => (
    <div key={index} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-primary-foreground/25 bg-primary-foreground/10 p-2">
      <span aria-hidden="true">{file.mimeType.startsWith("audio/") ? "🎧" : "📄"}</span>
      <span className="truncate text-xs" title={file.name}>{file.name}</span>
      <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
        {file.isUploading && <AttachmentUploadIndicator />}
      </span>
    </div>
  ))}</div>;
}

function AttachmentUploadIndicator() {
  return <span role="status" aria-label="Subiendo archivo" data-attachment-upload
    className="block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-45 motion-reduce:animate-none" />;
}

/** Same assistant box throughout upload, confirmation and model startup. */
function ThinkingIndicator() {
  const agentName = clientConfig.agents?.brief?.name || "Asistente";

  return (
    <div className="flex justify-start" data-chat-waiting-indicator role="status" aria-label="Esperando respuesta">
      <div className="max-w-[92%] rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm md:max-w-[80%] md:p-4">
        <div className="text-xs font-semibold mb-1 text-primary">
          {agentName}
        </div>
        <div className="flex items-center space-x-1 mt-3">
          <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"></div>
          <div
            className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
            style={{ animationDelay: "0.15s" }}
          ></div>
          <div
            className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
            style={{ animationDelay: "0.3s" }}
          ></div>
        </div>
      </div>
    </div>
  );
}

export { ChatMessage, ThinkingIndicator };
