import { defineConfig } from 'tsup'

/** 将 CLI 编译为 Node ESM；第三方包走 dependencies，避免 CJS 动态 require 问题 */
export default defineConfig({
  entry: ['cli/uieditor.ts'],
  outDir: 'dist-cli',
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // 仅打包本仓库源码；运行时从 node_modules 加载
  external: ['ag-psd', 'pngjs', 'buffer'],
  esbuildOptions(options) {
    options.legalComments = 'none'
  },
})
