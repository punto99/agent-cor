/**
 * Configuración de Tenant
 * 
 * Este archivo contiene la configuración del cliente/tenant activo.
 * Es la fuente única de verdad para personalización de la aplicación.
 * 
 * NOTA: Este es el proyecto base. Para crear un nuevo cliente:
 * 1. Haz un fork de este repositorio
 * 2. Modifica este archivo con los datos del nuevo cliente
 * 3. Ver FORK_SETUP_GUIDE.md para más detalles
 */

// =====================================================
// TIPOS
// =====================================================

const CLIENT = "Punto 99"
const CLIENT_ID = "pto99"

export interface TenantConfig {
  // ID único del tenant (usado internamente)
  id: string;

  // Información básica de la marca
  brand: {
    name: string;
    shortName: string;
    description: string;
    tagline: string;
  };

  // Logo - SVG inline para máxima flexibilidad
  logo: {
    // SVG que se adapta al tema (usa currentColor)
    svg: string;
    // Si el logo necesita fondo especial
    forceDarkBackground?: boolean;
  };

  // Paleta de colores (CSS HSL values sin hsl())
  colors: {
    primary: string;
    primaryForeground: string;
    secondary: string;
    secondaryForeground: string;
    accent: string;
    accentForeground: string;
    destructive: string;
    destructiveForeground: string;
    light: {
      background: string;
      foreground: string;
      card: string;
      cardForeground: string;
      muted: string;
      mutedForeground: string;
      border: string;
      input: string;
      ring: string;
    };
    dark: {
      background: string;
      foreground: string;
      card: string;
      cardForeground: string;
      muted: string;
      mutedForeground: string;
      border: string;
      input: string;
      ring: string;
    };
  };

  // Configuración de los agentes de IA
  // NOTA: Los prompts de los agentes se definen en convex/lib/serverConfig.ts
  // Aquí solo se define el nombre para mostrar en la UI
  agents: {
    // Agente orquestador — clasifica intención del usuario
    orchestrator: {
      name: string;
    };
    // Agente recolector de brief
    brief: {
      name: string;
    };
    // Agente de búsqueda en documentos/catálogos
    documentSearch: {
      name: string;
    };
    // Agente evaluador de resultados
    evaluator: {
      name: string;
    };
    // Agente revisor/supervisor de calidad
    reviewer: {
      name: string;
    };
  };

  // Agentes habilitados para este tenant
  // NOTA: Debe coincidir con enabledAgents en convex/lib/serverConfig.ts
  enabledAgents: {
    orchestrator: boolean;
    brief: boolean;
    documentSearch: boolean;
  };

  // Configuración de la UI
  ui: {
    welcomeMessage: string;
    inputPlaceholder: string;
    /** Mostrar opción de publicar tareas a herramienta externa (COR, etc.) */
    showPublishToExternalTool: boolean;
    /** Nombre visible de la herramienta externa (ej: "COR", "Trello") */
    externalToolName: string;
    sidebarWidth: string;
  };
}

// =====================================================
// CONFIGURACIÓN DEL TENANT ACTIVO
// =====================================================
const activeTenantConfig: TenantConfig = {
  id: CLIENT_ID,

  brand: {
    name: `${CLIENT} AI Assistant`,
    shortName: CLIENT,
    description: "Sistema de Gestión de Proyectos con IA",
    tagline: "Asistente inteligente para gestión de proyectos",
  },

  logo: {
    // Logo desde URL - se cargará como imagen
    // URL: https://www.beyondprompting.com/wp-content/uploads/cropped-bp-logo-alfa-transparent-large-1.png
    svg: `<svg viewBox="0 0 250 40" xmlns="http://www.w3.org/2000/svg">
      <text x="0" y="30" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="currentColor">Beyond Prompting</text>
    </svg>`,
    forceDarkBackground: false,
  },

  colors: {
    // Colores base (iguales para todos los tenants - vienen de globals.css)
    primary: "238 76% 55%",
    primaryForeground: "0 0% 100%",
    secondary: "210 40% 96.1%",
    secondaryForeground: "222.2 47.4% 11.2%",
    accent: "210 40% 96.1%",
    accentForeground: "222.2 47.4% 11.2%",
    destructive: "0 84.2% 60.2%",
    destructiveForeground: "0 0% 100%",
    light: {
      background: "0 0% 100%",
      foreground: "222.2 84% 4.9%",
      card: "0 0% 100%",
      cardForeground: "222.2 84% 4.9%",
      muted: "210 40% 96.1%",
      mutedForeground: "215.4 16.3% 46.9%",
      border: "214.3 31.8% 91.4%",
      input: "214.3 31.8% 91.4%",
      ring: "238 76% 55%",
    },
    dark: {
      background: "222.2 84% 4.9%",
      foreground: "210 40% 98%",
      card: "222.2 84% 4.9%",
      cardForeground: "210 40% 98%",
      muted: "217.2 32.6% 17.5%",
      mutedForeground: "215 20.2% 65.1%",
      border: "217.2 32.6% 17.5%",
      input: "217.2 32.6% 17.5%",
      ring: "238 76% 55%",
    },
  },

  // Configuración de agentes - Solo nombres para UI
  // Los prompts se definen en convex/lib/serverConfig.ts
  agents: {
    orchestrator: {
      name: `Orquestador ${CLIENT}`,
    },
    brief: {
      name: `Asistente de Brief ${CLIENT}`,
    },
    documentSearch: {
      name: `Buscador de Documentos ${CLIENT}`,
    },
    evaluator: {
      name: `Evaluador de Resultados ${CLIENT}`,
    },
    reviewer: {
      name: `Supervisor de Calidad ${CLIENT}`,
    },
  },

  // Agentes habilitados — debe coincidir con convex/lib/serverConfig.ts
  enabledAgents: {
    orchestrator: true,   // true por default, false para clientes sin orquestador
    brief: true,
    documentSearch: true,
  },

  ui: {
    welcomeMessage: `¡Hola! Soy tu asistente de ${CLIENT}. ¿En qué puedo ayudarte hoy?`,
    inputPlaceholder: "Escribe tu mensaje aquí...",
    showPublishToExternalTool: true,
    externalToolName: "COR",
    sidebarWidth: "280px",
  },
};

// =====================================================
// TENANT ACTIVO
// =====================================================
export const ACTIVE_TENANT = CLIENT_ID;

// =====================================================
// EXPORTACIONES
// =====================================================

// Configuración activa
export const tenantConfig = activeTenantConfig;

// Alias para compatibilidad con código existente
export const clientConfig = tenantConfig;

export default tenantConfig;
