import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR defaults to OFF.
      //
      // This app is usually previewed inside Google AI Studio, whose iframe
      // is served from https://aistudio.google.com over TLS on port 443.
      // Vite's default HMR client tries to open a plain `ws://` socket back
      // to the dev server's host:port, which the AI Studio proxy drops,
      // producing the recurring "WebSocket closed without opened." unhandled
      // rejection visible in the preview console. Disabling HMR removes the
      // socket attempt entirely; the app still renders, you just refresh the
      // preview manually after edits (which is also what the original
      // comment about "preventing flickering during agent edits" wanted).
      //
      // For local dev you can opt back in with ENABLE_HMR=true. Behind a TLS
      // proxy (e.g. a Cloud IDE), also set HMR_CLIENT_PORT=443 and
      // HMR_PROTOCOL=wss so the browser dials the proxy correctly instead of
      // the underlying dev port.
      hmr:
        process.env.ENABLE_HMR === 'true' &&
        process.env.DISABLE_HMR !== 'true'
          ? {
              clientPort: process.env.HMR_CLIENT_PORT
                ? Number(process.env.HMR_CLIENT_PORT)
                : undefined,
              protocol:
                (process.env.HMR_PROTOCOL as 'ws' | 'wss' | undefined) ||
                undefined,
              host: process.env.HMR_HOST || undefined,
            }
          : false,
    },
  };
});
