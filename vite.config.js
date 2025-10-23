import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Configuração completa para funcionar tanto no dev quanto no preview/deploy
export default defineConfig({
  plugins: [react()],
  base: './', // 👈 ESSA LINHA é a chave!
});
