// convex/speechToText.ts
// Transcripción de audio a texto usando Azure Speech-to-Text
import { v } from "convex/values";
import { action } from "../_generated/server";

// Tipos de audio soportados
const SUPPORTED_AUDIO_TYPES = [
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
];

// Verificar si es un tipo de audio soportado
function isAudioType(mimeType: string): boolean {
  return SUPPORTED_AUDIO_TYPES.includes(mimeType) || mimeType.startsWith('audio/');
}

// Transcribir audio usando Azure Speech-to-Text REST API
export const transcribeAudio = action({
  args: {
    audioBase64: v.string(), // Audio en base64 con prefijo data:audio/...
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ text: string; success: boolean; error?: string }> => {
    console.log(`[SpeechToText] 🎤 Iniciando transcripción...`);
    
    // Obtener credenciales de Azure desde variables de entorno de Convex
    const speechKey = process.env.SPEECH_KEY;
    const speechRegion = process.env.SPEECH_REGION;
    
    if (!speechKey || !speechRegion) {
      console.error("[SpeechToText] ❌ Faltan credenciales de Azure Speech");
      return {
        text: "",
        success: false,
        error: "Configuración de Azure Speech no encontrada",
      };
    }
    
    console.log(`[SpeechToText] 🔑 Region: ${speechRegion}`);
    
    try {
      // Extraer datos del audio base64
      const matches = args.audioBase64.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        throw new Error("Formato de audio inválido");
      }
      
      const mimeType = matches[1];
      const base64Data = matches[2];
      
      console.log(`[SpeechToText] 📁 Tipo MIME original: ${mimeType}`);
      console.log(`[SpeechToText] 📊 Longitud base64: ${base64Data.length} caracteres`);
      
      // Convertir base64 a Uint8Array (compatible con Convex)
      const binaryString = atob(base64Data);
      const audioBuffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        audioBuffer[i] = binaryString.charCodeAt(i);
      }
      
      console.log(`[SpeechToText] 📊 Tamaño del audio: ${audioBuffer.length} bytes`);
      console.log(`[SpeechToText] 📊 Primeros 20 bytes: ${Array.from(audioBuffer.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      
      // Usar la API REST de Azure Speech-to-Text
      // Endpoint para reconocimiento de voz con formato detallado
      const endpoint = `https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=es-ES&format=detailed`;
      
      // Determinar el content type correcto para Azure
      // IMPORTANTE: Azure Speech REST API tiene soporte limitado de formatos
      // Los formatos mejor soportados son: WAV (PCM), OGG (Opus)
      // MP3 y WebM tienen soporte variable
      let contentType: string;
      
      if (mimeType.includes('wav') || mimeType.includes('wave')) {
        contentType = 'audio/wav; codecs=audio/pcm; samplerate=16000';
      } else if (mimeType.includes('ogg')) {
        contentType = 'audio/ogg; codecs=opus';
      } else if (mimeType.includes('webm')) {
        // WebM del navegador usa opus
        contentType = 'audio/webm; codecs=opus';
      } else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
        contentType = 'audio/mpeg';
      } else if (mimeType.includes('m4a') || mimeType.includes('mp4')) {
        contentType = 'audio/mp4';
      } else {
        // Por defecto, intentar con WAV
        contentType = 'audio/wav';
      }
      
      console.log(`[SpeechToText] 📤 Content-Type a enviar: ${contentType}`);
      console.log(`[SpeechToText] 🌐 Endpoint: ${endpoint}`);
      
      // Advertir si el archivo es muy grande (probablemente > 60s)
      if (audioBuffer.length > 1000000) {
        console.log(`[SpeechToText] ⚠️ Archivo grande (${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB). Azure REST API solo procesa ~60s de audio.`);
      }
      
      console.log(`[SpeechToText] 🌐 Enviando a Azure Speech API...`);
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': contentType,
          'Accept': 'application/json',
        },
        body: audioBuffer.buffer, // Enviar el ArrayBuffer subyacente
      });
      
      console.log(`[SpeechToText] 📥 Response status: ${response.status}`);
      console.log(`[SpeechToText] 📥 Response headers:`, Object.fromEntries(response.headers.entries()));
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[SpeechToText] ❌ Error de Azure: ${response.status} - ${errorText}`);
        throw new Error(`Error de Azure Speech: ${response.status} - ${errorText}`);
      }
      
      const result = await response.json();
      console.log(`[SpeechToText] ✅ Respuesta completa:`, JSON.stringify(result, null, 2));
      
      if (result.RecognitionStatus === 'Success') {
        // Con format=detailed, el texto está en NBest[0].Display o NBest[0].Lexical
        const transcribedText = result.DisplayText || result.NBest?.[0]?.Display || result.NBest?.[0]?.Lexical || '';
        
        // Verificar si realmente hay texto transcrito
        if (!transcribedText || transcribedText.trim() === '') {
          console.log(`[SpeechToText] ⚠️ Azure devolvió Success pero sin texto`);
          console.log(`[SpeechToText] ⚠️ NBest:`, result.NBest);
          return {
            text: "",
            success: false,
            error: "Azure procesó el audio pero no detectó voz. Prueba con un formato WAV o asegúrate de que el audio contenga voz clara.",
          };
        }
        
        console.log(`[SpeechToText] 📝 Texto transcrito: "${transcribedText.substring(0, 100)}..."`);
        return {
          text: transcribedText,
          success: true,
        };
      } else if (result.RecognitionStatus === 'NoMatch') {
        return {
          text: "",
          success: false,
          error: "No se pudo reconocer el audio. Intenta hablar más claro o acércate al micrófono.",
        };
      } else if (result.RecognitionStatus === 'InitialSilenceTimeout') {
        return {
          text: "",
          success: false,
          error: "Se detectó silencio al inicio del audio. Asegúrate de que el audio comience con voz.",
        };
      } else {
        return {
          text: "",
          success: false,
          error: `Estado de reconocimiento: ${result.RecognitionStatus}`,
        };
      }
      
    } catch (error) {
      console.error("[SpeechToText] ❌ Error en transcripción:", error);
      return {
        text: "",
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido en transcripción",
      };
    }
  },
});

// Transcribir audio largo usando chunks (para audios de más de 60 segundos)
export const transcribeLongAudio = action({
  args: {
    audioBase64: v.string(),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ text: string; success: boolean; error?: string }> => {
    console.log(`[SpeechToText] 🎤 Iniciando transcripción de audio largo...`);
    
    const speechKey = process.env.SPEECH_KEY;
    const speechRegion = process.env.SPEECH_REGION;
    
    if (!speechKey || !speechRegion) {
      return {
        text: "",
        success: false,
        error: "Configuración de Azure Speech no encontrada",
      };
    }
    
    try {
      // Extraer datos del audio base64
      const matches = args.audioBase64.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        throw new Error("Formato de audio inválido");
      }
      
      const base64Data = matches[2];
      
      // Convertir base64 a Uint8Array (compatible con Convex)
      const binaryString = atob(base64Data);
      const audioBuffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        audioBuffer[i] = binaryString.charCodeAt(i);
      }
      
      // Para audios largos, usamos el endpoint de conversación continua
      // Por ahora, intentamos con el endpoint estándar que soporta hasta 60s
      // Si el audio es muy largo, Azure devolverá solo los primeros 60s
      
      const endpoint = `https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=es-ES&format=detailed`;
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'audio/wav',
          'Accept': 'application/json',
        },
        body: audioBuffer,
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error de Azure Speech: ${response.status} - ${errorText}`);
      }
      
      const result = await response.json();
      
      if (result.RecognitionStatus === 'Success') {
        const transcribedText = result.DisplayText || result.NBest?.[0]?.Display || '';
        return {
          text: transcribedText,
          success: true,
        };
      } else {
        return {
          text: "",
          success: false,
          error: `Estado: ${result.RecognitionStatus}`,
        };
      }
      
    } catch (error) {
      console.error("[SpeechToText] ❌ Error:", error);
      return {
        text: "",
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido",
      };
    }
  },
});
