import type { Metadata } from "next";
import "./globals.css";
import "./components/board/boardTheme.css";
import { ConvexClientProvider } from "./ConvexClientProvider";
import UserContextProvider from "./UserContextProvider";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { ThemeProvider } from "./contexts/ThemeContext";
import { clientConfig } from "@/config/tenant.config";

export const metadata: Metadata = {
  title: `${clientConfig.brand.name}`,
  description: clientConfig.brand.tagline,
};

// Storage key único para el tema
const THEME_STORAGE_KEY = "agent-theme";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Script para evitar flash de tema
  const themeScript = `
    (function() {
      try {
        var theme = localStorage.getItem('${THEME_STORAGE_KEY}');
        
        if (!theme) {
          theme = 'light';
          localStorage.setItem('${THEME_STORAGE_KEY}', 'light');
        }
        
        var isDark = theme === 'dark' || 
          (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        if (isDark) {
          document.documentElement.classList.add('dark');
        }
      } catch (e) {}
    })();
  `;

  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ConvexAuthNextjsServerProvider>
          <ConvexClientProvider>
            <UserContextProvider>
              <ThemeProvider>{children}</ThemeProvider>
            </UserContextProvider>
          </ConvexClientProvider>
        </ConvexAuthNextjsServerProvider>
      </body>
    </html>
  );
}
