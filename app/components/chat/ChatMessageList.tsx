"use client";

import { MessageContent, Message } from "./MessageContent";
import { clientConfig } from "@/config/tenant.config";

interface ChatMessageListProps {
  messages: Message[];
  isAgentThinking: boolean;
  currentThreadId: string | null;
  isCreatingThread: boolean;
  showUserLinkPreviews?: boolean;
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
        />
      ))}

      {/* Indicador de "pensando" cuando el agente está procesando */}
      {isAgentThinking && <ThinkingIndicator />}
    </>
  );
}

/**
 * Componente para un mensaje individual
 */
function ChatMessage({
  message,
  showUserLinkPreviews,
}: {
  message: Message;
  showUserLinkPreviews: boolean;
}) {
  return (
    <div
      className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[80%] rounded-lg p-4 ${
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

        <MessageContent
          message={message}
          showLinkPreviews={showUserLinkPreviews && message.role === "user"}
        />

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

/**
 * Indicador de "pensando" cuando el agente está procesando
 * Usa la misma caja que los mensajes del asistente pero con puntos animados
 */
function ThinkingIndicator() {
  const agentName = clientConfig.agents?.brief?.name || "Asistente";

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-lg p-4 bg-card text-card-foreground shadow-sm border border-border">
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
