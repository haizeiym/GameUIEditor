import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5180,
  },
  // pngjs 仅 Node CLI 使用；排除预构建，避免 util.inherits 进浏览器
  optimizeDeps: {
    exclude: ['pngjs', 'buffer'],
  },
})
