"use client";

import ReactMarkdown from "react-markdown";
import type { EvaluationMessage } from "./types";

interface MessageRendererProps {
  message: EvaluationMessage;
}

/**
 * Renderiza un mensaje individual de evaluación
 */
export function MessageRenderer({ message }: MessageRendererProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] rounded-lg p-3 ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-card text-card-foreground shadow-sm border border-border"
        }`}
      >
        {!isUser && message.agentName && (
          <div className="text-xs font-semibold mb-1 text-primary">
            {message.agentName}
          </div>
        )}
        <ReactMarkdown
          components={{
            p: ({ children }) => <p className="mb-4">{children}</p>,
            strong: ({ children }) => (
              <strong className="font-semibold">{children}</strong>
            ),
            ul: ({ children }) => (
              <ul className="list-disc ml-6 mb-4">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal ml-6 mb-4">{children}</ol>
            ),
            li: ({ children }) => <li className="mb-1">{children}</li>,
            code: ({ children }) => (
              <code className="bg-muted px-1 rounded">{children}</code>
            ),
            pre: ({ children }) => (
              <pre className="bg-muted p-4 rounded overflow-x-auto mb-4">
                {children}
              </pre>
            ),
          }}
        >
          {typeof message.content === "string"
            ? message.content
            : message.text || ""}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/**
 * Indicador de que el evaluador está analizando
 */
export function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-lg p-3 bg-muted border border-border animate-pulse">
        <div className="flex items-center gap-2 text-primary">
          <div className="w-6 h-6 border-2 border-muted-foreground border-t-primary rounded-full animate-spin"></div>
          <span className="text-sm font-medium">Analizando...</span>
        </div>
      </div>
    </div>
  );
}

interface EvaluationMessageListProps {
  messages: EvaluationMessage[];
  isThinking: boolean;
  errorMessage?: string | null;
}

/**
 * Lista de mensajes de evaluación
 */
export function EvaluationMessageList({
  messages,
  isThinking,
  errorMessage,
}: EvaluationMessageListProps) {
  return (
    <div className="flex-1 p-4 space-y-4 overflow-y-auto">
      {messages.length === 0 && (
        <div className="text-center py-8">
          <div className="text-5xl mb-4">📤</div>
          <h3 className="text-lg font-medium text-foreground mb-2">
            Sube el producto final
          </h3>
          <p className="text-sm text-muted-foreground max-w-xs mx-auto">
            Adjunta la imagen del resultado final para que el evaluador lo
            compare con el requerimiento original.
          </p>
        </div>
      )}

      {messages.map((message) => (
        <MessageRenderer key={message.key} message={message} />
      ))}

      {errorMessage && (
        <div className="flex justify-start">
          <div className="max-w-[90%] rounded-lg p-3 bg-destructive/10 text-destructive border border-destructive/20">
            <div className="text-sm font-medium mb-1">
              No se pudo completar la evaluación
            </div>
            <p className="text-sm">
              {errorMessage} Puedes subir el archivo nuevamente e intentarlo
              otra vez.
            </p>
          </div>
        </div>
      )}

      {isThinking && <ThinkingIndicator />}
    </div>
  );
}
