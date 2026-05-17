import { defineConfig } from 'astro/config'
import tailwind from '@astrojs/tailwind'

export default defineConfig({
  site: 'https://your-username.github.io',
  base: '/claude-code-blog',
  output: 'static',
  integrations: [tailwind()],
})