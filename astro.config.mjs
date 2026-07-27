import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://demonewsaggregator.com',
  output: 'static',
  trailingSlash: 'never',
  integrations: [
    mdx(),
    sitemap({ changefreq: 'daily', priority: 0.7, lastmod: new Date() }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
