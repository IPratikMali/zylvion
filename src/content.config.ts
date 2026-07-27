import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    author: z.string().default('TechAudit Editorial Team'),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    updatedDate: z.coerce.date().optional(),
    coverImage: z.string().optional(),
  }),
});

const news = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/news' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    summary: z.string().optional(),
    keyFacts: z.array(z.string()).optional(),
    pubDate: z.coerce.date(),
    category: z.string(),
    source: z.string(),
    sourceSite: z.string(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog, news };
