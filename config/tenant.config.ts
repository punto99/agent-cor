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
    svg: `<svg viewBox="0 0 147.79 83.37"><path fill="currentColor" d="M23.81,52a7.51,7.51,0,1,1,7.5-7.51A7.51,7.51,0,0,1,23.81,52Zm0-18.06A10.55,10.55,0,1,0,34.36,44.51,10.55,10.55,0,0,0,23.81,34Z"/><path fill="white" d="M55.2,21.79a13.15,13.15,0,0,0-3.36,9.4c0,3.86,1.1,6.88,3.36,9.15q3.13,3.52,8.81,3.53a11.5,11.5,0,0,0,8.89-3.53,13.37,13.37,0,0,0,3.28-9.4,13.06,13.06,0,0,0-3.36-9.32,11.65,11.65,0,0,0-8.73-3.52A11.4,11.4,0,0,0,55.2,21.79Zm25.26-3.27c3.69,5.12,5.62,12.26,5.62,21.49,0,9.73-2,17.62-6,23.66-4.11,6-9.57,9.15-16.45,9.15C52,72.82,45.47,67.36,44,56.54h8.89c1.18,5.79,4.87,8.73,10.91,8.73,4.11,0,7.39-2.1,9.91-6.13,2.35-3.85,3.6-8.72,3.6-14.52,0-.33-.08-.67-.08-1.08h-.34a17.07,17.07,0,0,1-6.37,5.87,18.87,18.87,0,0,1-8.31,1.84c-5.87,0-10.66-1.93-14.18-5.7s-5.12-8.47-5.12-14.35a19.69,19.69,0,0,1,6-14.78,20.46,20.46,0,0,1,14.94-5.87C71.06,10.55,76.59,13.15,80.46,18.52Z"/><path fill="white" d="M103.65,21.79a13.15,13.15,0,0,0-3.36,9.4c0,3.86,1.09,6.88,3.36,9.15q3.13,3.52,8.81,3.53a11.5,11.5,0,0,0,8.89-3.53,13.37,13.37,0,0,0,3.28-9.4,13.06,13.06,0,0,0-3.36-9.32,11.65,11.65,0,0,0-8.73-3.52A11.4,11.4,0,0,0,103.65,21.79Zm25.26-3.27c3.69,5.12,5.62,12.26,5.62,21.49,0,9.73-2,17.62-5.95,23.66-4.11,6-9.57,9.15-16.45,9.15-11.67,0-18.21-5.46-19.72-16.28h8.89c1.18,5.79,4.87,8.73,10.91,8.73,4.11,0,7.39-2.1,9.91-6.13,2.35-3.85,3.6-8.72,3.6-14.52,0-.33-.08-.67-.08-1.08h-.34a17,17,0,0,1-6.38,5.87,18.8,18.8,0,0,1-8.3,1.84c-5.87,0-10.66-1.93-14.18-5.7s-5.12-8.47-5.12-14.35a19.69,19.69,0,0,1,6-14.78,20.46,20.46,0,0,1,14.94-5.87c7.3,0,12.84,2.6,16.7,8Z"/>
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
