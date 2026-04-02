// convex/tools/nowTool.ts
// Tool que devuelve la fecha y hora actual
import { createTool } from "@convex-dev/agent";
import { z } from "zod";

export const nowTool = createTool({
  description: `Obtener la fecha y hora actual. Usar esta herramienta cuando necesites saber que dia es hoy, 
  por ejemplo para calcular deadlines, verificar timings, o dar contexto temporal al usuario.`,
  args: z.object({}),
  handler: async (): Promise<string> => {
    const now = new Date();
    
    // Formato legible en español
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Guayaquil', // Ecuador timezone
    };
    
    const fechaLegible = now.toLocaleDateString('es-EC', options);
    const fechaISO = now.toISOString();
    
    console.log(`[NowTool] Fecha actual: ${fechaLegible}`);
    
    return `Fecha y hora actual: ${fechaLegible} (${fechaISO})`;
  },
});
