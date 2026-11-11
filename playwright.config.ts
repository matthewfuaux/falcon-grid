import { defineConfig } from '@playwright/test';

const PORT = 4410;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `vite e2e/fixture --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    // Headless shell: software canvas.
    { name: 'software', use: { browserName: 'chromium' } },
    // Full Chromium with SwiftShader: GPU-accelerated canvas, as on real hardware.
    {
      name: 'gpu',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        launchOptions: {
          args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
});
